import { isKnownNumber, UNKNOWN_TEXT } from './math'
import { MINERALS } from './minerals'
import { STATUS, envelope, getRule, isAvailable, ofRule, registerRule, unavailable, weakestStatus } from './provenance'

// The Designed page's component tables: which columns each research category shows, the figures derived from a component's stored values, and the tags a name carries. Columns are { text, value, numeric, format(item, f), note?(item, f), title?(item, f), none?(item), hint?, perHS?, compareOnly?, better?, skipZero?, showZero?, needs?, rule? }: `value` is the item key the table sorts by, `format` the cell's text and `note` a second line under it, `title` a tooltip, `none` marks a cell that reads "—" because the design has no such figure, `perHS` a column the table shows only when the page's per-hull-space toggle is on (Compare always has it), `compareOnly` a figure only Compare shows, `better` the side of the figure that is the better one (`'high'` or `'low'`, left out when neither is), `skipZero` that a zero is no value, so it takes no part in best and worst, `showZero` that a zero is a figure and reads 0, `needs` the other item keys the cell's text reads (a missing one makes the cell unknown), and `rule` the registered rule of a conversion the whole column makes, which its header marks. A cell whose figure or input is not stored reads "—" with an unavailable mark, which tells it from a design that has none. `f` is `{ count }`, the page's number formatter.

export const TONS_PER_HULL_SPACE = 50
export const TONS_PER_MSP = 2.5
const KELVIN_TO_CELSIUS = 273

export const HIGH = 'high'
export const LOW = 'low'

// Strongest signature each passive range column is worked out against.
const SIGNATURES = [10, 100, 1000, 10000]

export const MISSILE_CATEGORY_ID = 4
export const SPECIES_CATEGORY_ID = 47

// The weapon categories whose range and damage come from the beam rules.
const BEAM_CATEGORY_IDS = [2, 27, 29, 26, 28, 35, 39]
const PASSIVE_CATEGORY_IDS = [34, 14]
const JUMP_DRIVE_TYPE_ID = 16
const COMMERCIAL_JUMP_FUNCTION = 2

const PROTOTYPES = { 1: 'Prototype', 2: 'Future prototype', 3: 'Research prototype' }

const DESIGNED_VERSIONS = ['2.7.x']
const STORED = 'designedTech.stored'
const MEASURE = 'designedTech.measure'
const PER_SPACE = 'designedTech.perSpace'
const PER_COST = 'designedTech.perCost'
const TONNAGE = 'designedTech.tonnage'
const COMPARE_VERDICT = 'designedTech.compareVerdict'
const UNIT_CONVERSION = 'designedTech.unitConversion'

// The rules of the Designed page's counts, usage and derived figures, each registered once with the game versions it holds for and how far it is checked (utilities/provenance.js).
registerRule({
  id: 'designedTech.count',
  versions: DESIGNED_VERSIONS,
  units: 'designs',
  verification: 'confirmed',
  structure: ['FCT_RaceTech.TechID', 'FCT_ShipDesignComponents', 'FCT_MissileType', 'FCT_Species'],
  note: 'Count of the designs the race knows in the category before the filters: its researched designs and the base components it starts with, each once.',
})

registerRule({
  id: 'designedTech.inUse',
  versions: DESIGNED_VERSIONS,
  units: 'designs',
  verification: 'confirmed',
  structure: ['FCT_ClassComponent.ComponentID, ClassID', 'FCT_ShipClass.GameID, RaceID'],
  note: 'Count of designs that at least one class of the race mounts, obsolete classes included. A missile type or a species is never mounted, so it has no figure.',
})

registerRule({
  id: 'designedTech.unused',
  versions: DESIGNED_VERSIONS,
  units: 'designs',
  verification: 'confirmed',
  structure: ['FCT_ClassComponent.ComponentID, ClassID', 'FCT_ShipClass.GameID, RaceID'],
  note: 'Count of designs that no class of the race mounts. A missile type or a species is never mounted, so it has no figure.',
})

registerRule({
  id: 'designedTech.obsolete',
  versions: DESIGNED_VERSIONS,
  units: 'designs',
  verification: 'confirmed',
  structure: ['FCT_RaceTech.Obsolete'],
  note: 'Count of designs the race has marked obsolete. A species the race holds without a tech row is not marked.',
})

registerRule({
  id: 'designedTech.shipCount',
  versions: DESIGNED_VERSIONS,
  units: 'ships',
  verification: 'confirmed',
  structure: ['FCT_Ship.ShipClassID, Destroyed, GameID, RaceID', 'FCT_ClassComponent.ClassID'],
  note: 'Ships of the race still in service (not destroyed) on the classes that mount the designs, each class counted once. A class with no ship is a known 0.',
})

registerRule({
  id: 'designedTech.usage',
  versions: DESIGNED_VERSIONS,
  units: 'classes, ships, mounted per ship',
  verification: 'confirmed',
  structure: ['FCT_ClassComponent.ComponentID, ClassID, NumComponent', 'FCT_ShipClass.ClassName, Obsolete', 'FCT_Ship.ShipClassID, Destroyed'],
  note: 'Per design: the classes of the race that mount it, how many it mounts per ship and the ships of each class still in service. A design on no class is a known 0 classes and 0 ships; a class mount without its count is not counted and is named as missing.',
})

registerRule({
  id: STORED,
  versions: DESIGNED_VERSIONS,
  units: '',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents', 'FCT_MissileType', 'FCT_Species'],
  note: 'A column of the design\'s own record, shown as the save stores it. The mark appears where the column is not stored.',
})

registerRule({
  id: MEASURE,
  versions: DESIGNED_VERSIONS,
  units: 'the unit of the component type',
  verification: 'estimated',
  structure: ['FCT_ShipDesignComponents.ComponentValue, ComponentTypeID'],
  note: 'The stored component value read in the unit its component type counts it in (litres, MSP, colonists, tons of cargo, survey points an hour); a hangar, a jump drive and a cloak store hull spaces, shown in tons. Which type stores which unit is the page\'s own table, not checked against the game\'s display.',
})

registerRule({
  id: PER_SPACE,
  versions: DESIGNED_VERSIONS,
  units: 'figure per hull space (per MSP for missiles)',
  verification: 'estimated',
  structure: ['FCT_ShipDesignComponents.Size and the figure it rates', 'FCT_MissileType.Size'],
  note: 'A figure over the design\'s size in hull spaces (MSP for a missile or missile engine): the page\'s own rating, with no source in the save. A design with no size above 0 has none.',
})

registerRule({
  id: PER_COST,
  versions: DESIGNED_VERSIONS,
  units: 'figure per build point',
  verification: 'estimated',
  structure: ['FCT_ShipDesignComponents.Cost and the figure it rates', 'FCT_MissileType.Cost'],
  note: 'A figure over the design\'s build cost: the page\'s own rating, with no source in the save. A design with no cost above 0 has none.',
})

registerRule({
  id: TONNAGE,
  versions: DESIGNED_VERSIONS,
  units: 't',
  verification: 'estimated',
  structure: ['FCT_ShipDesignComponents.Size, ComponentValue', 'FCT_MissileType.Size'],
  assumptions: ['One hull space is 50 tons and one missile size point 2.5 tons'],
  note: 'A size or capacity stored in hull spaces or missile size points, shown in tons. The two constants are the game\'s published ones and are not compared with a stored figure.',
})

registerRule({
  id: UNIT_CONVERSION,
  versions: DESIGNED_VERSIONS,
  units: 'the unit shown',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents', 'FCT_MissileType', 'FCT_Species'],
  note: 'A stored figure shown in another unit: kilometres in millions of kilometres, Kelvin in degrees Celsius (less 273), a seconds figure in minutes or hours, a guidance bonus over 1 as a percentage.',
})

registerRule({
  id: 'designedTech.beamDamage',
  versions: DESIGNED_VERSIONS,
  units: 'damage per firing',
  verification: 'confirmed',
  structure: ['FCT_ShipDesignComponents.DamageOutput, NumberOfShots'],
  note: 'The damage of one firing: the stored damage times the shots a firing makes. Arithmetic on stored values.',
})

registerRule({
  id: 'designedTech.beamRange',
  versions: DESIGNED_VERSIONS,
  units: 'km',
  verification: 'estimated',
  structure: ['FCT_ShipDesignComponents.MaxWeaponRange, DamageOutput, RangeModifier'],
  note: 'The fixed maximum range when the weapon has one, otherwise its damage times its range modifier, truncated. The rule is from the beam documentation and is not compared with a stored range.',
})

registerRule({
  id: 'designedTech.beamInterval',
  versions: DESIGNED_VERSIONS,
  units: 's',
  verification: 'estimated',
  structure: ['FCT_ShipDesignComponents.PowerRequirement, RechargeRate'],
  note: 'Seconds between firings: steps of 5 seconds, one step for a weapon that needs no power and otherwise the power over the capacitor recharge, rounded up. The rule is from the beam documentation and is not compared with a stored interval. A weapon that needs power and has no recharge has none.',
})

registerRule({
  id: 'designedTech.damagePerSecond',
  versions: DESIGNED_VERSIONS,
  units: 'damage per second',
  verification: 'estimated',
  structure: ['designedTech.beamDamage', 'designedTech.beamInterval'],
  note: 'The damage of a firing over the seconds between firings, at point-blank range. It rests on the interval rule.',
})

registerRule({
  id: 'designedTech.passiveRange',
  versions: DESIGNED_VERSIONS,
  units: 'km',
  verification: 'estimated',
  structure: ['FCT_ShipDesignComponents.ComponentValue'],
  note: 'The range at which a passive sensor sees a signature: the square root of its sensitivity times the signature, times 250,000 km. The rule is from the sensor documentation and is not compared with a stored range.',
})

registerRule({
  id: 'designedTech.shieldRate',
  versions: DESIGNED_VERSIONS,
  units: 'shield strength per second',
  verification: 'estimated',
  structure: ['FCT_ShipDesignComponents.ComponentValue, RechargeRate'],
  note: 'Shield strength restored each second: its strength over the recharge time; a generator with no recharge restores none. Not compared with a stored figure.',
})

registerRule({
  id: 'designedTech.reload',
  versions: DESIGNED_VERSIONS,
  units: 'min or h',
  verification: 'estimated',
  structure: ['FCT_ShipDesignComponents.RateOfFire'],
  note: 'A reload given in seconds shown in minutes (a hangar deck reloads at 60 seconds to the minute) or in hours (a maintenance facility reloads six times as fast). The two divisors are the page\'s reading of the rules and are not compared with a stored figure.',
})

registerRule({
  id: 'designedTech.missileRange',
  versions: DESIGNED_VERSIONS,
  units: 'km',
  verification: 'estimated',
  structure: ['FCT_MissileType.MaxRange, SecondStageID', 'the second stage\'s FCT_MissileType.MaxRange'],
  note: 'The first stage\'s range plus the second stage\'s own range; a second stage that has a stage of its own is not followed further, so such a missile\'s total is short.',
})

registerRule({
  id: COMPARE_VERDICT,
  versions: DESIGNED_VERSIONS,
  units: 'designs ranked',
  verification: 'confirmed',
  structure: ['the figures of the designs picked'],
  note: 'The best and worst of a figure among the designs picked, which only designs of one component type can give. A design with no figure takes no part and is named as missing; with fewer than two figures there is no verdict.',
})

const INPUT_NAMES = {
  ComponentValue: 'the component value',
  Size: 'the size',
  Cost: 'the build cost',
  DamageOutput: 'the damage',
  NumberOfShots: 'the shots a firing makes',
  MaxWeaponRange: 'the maximum range',
  RangeModifier: 'the range modifier',
  PowerRequirement: 'the power a firing takes',
  RechargeRate: 'the recharge rate',
  RateOfFire: 'the rate of fire',
  MaxRange: 'the first stage range',
  SecondStageID: 'whether the missile has a second stage',
  SecondStage: 'the second stage',
  SecondStageMaxRange: 'the second stage range',
  WarheadStrength: 'the warhead strength',
  ShipDecoy: 'the ship decoy flag',
}

const inputName = (key) => INPUT_NAMES[key] || key

const none = () => []

// The figures `augment*` works out from stored values: each one's rule, the item keys it reads (a name here is another figure, followed down to what is stored) and the ones that must be above 0 because it divides by them. A figure whose input is missing is null, never 0.
const FIGURES = {
  Measure: { rule: MEASURE, needs: () => ['ComponentValue'], positive: none },
  MeasurePerHS: { rule: PER_SPACE, needs: () => ['Measure'], positive: () => ['Size'] },
  MeasurePerCost: { rule: PER_COST, needs: () => ['Measure'], positive: () => ['Cost'] },
  TotalDamage: { rule: 'designedTech.beamDamage', needs: () => ['DamageOutput', 'NumberOfShots'], positive: none },
  Range: { rule: 'designedTech.beamRange', needs: (item) => ['MaxWeaponRange', ...(item.MaxWeaponRange > 0 ? [] : ['DamageOutput', 'RangeModifier'])], positive: none },
  Interval: { rule: 'designedTech.beamInterval', needs: (item) => ['PowerRequirement', ...(item.PowerRequirement === 0 ? [] : ['RechargeRate'])], positive: (item) => (item.PowerRequirement === 0 ? [] : ['RechargeRate']) },
  DamagePerHS: { rule: PER_SPACE, needs: () => ['TotalDamage'], positive: () => ['Size'] },
  DamagePerSecond: { rule: 'designedTech.damagePerSecond', needs: () => ['TotalDamage', 'Interval'], positive: none },
  DamagePerSecondPerHS: { rule: PER_SPACE, needs: () => ['DamagePerSecond'], positive: () => ['Size'] },
  DamagePerSecondPerCost: { rule: PER_COST, needs: () => ['DamagePerSecond'], positive: () => ['Cost'] },
  ShieldPerSecond: { rule: 'designedTech.shieldRate', needs: () => ['ComponentValue', 'RechargeRate'], positive: none },
  ShieldPerSecondPerHS: { rule: PER_SPACE, needs: () => ['ShieldPerSecond'], positive: () => ['Size'] },
  HangarReload: { rule: 'designedTech.reload', needs: () => ['RateOfFire'], positive: none },
  MFReload: { rule: 'designedTech.reload', needs: () => ['RateOfFire'], positive: none },
  TotalRange: { rule: 'designedTech.missileRange', needs: (item) => ['MaxRange', 'SecondStageID', ...(item.SecondStageID ? ['SecondStageMaxRange'] : [])], positive: none },
  WarheadPerMSP: { rule: PER_SPACE, needs: (item) => ['ShipDecoy', ...(item.ShipDecoy ? [] : ['WarheadStrength'])], positive: (item) => (item.ShipDecoy ? [] : ['Size']) },
  WarheadPerCost: { rule: PER_COST, needs: (item) => ['ShipDecoy', ...(item.ShipDecoy ? [] : ['WarheadStrength'])], positive: (item) => (item.ShipDecoy ? [] : ['Cost']) },
  ...Object.fromEntries(SIGNATURES.map((signature) => [`Range${signature}`, { rule: 'designedTech.passiveRange', needs: () => ['ComponentValue'], positive: none }])),
}

// The stored inputs a figure lacks, by name: each stored key it reads that is not a number, and each divisor that is not above 0.
const gapsOf = (item, key) => {
  const spec = FIGURES[key]
  const gaps = []

  spec.needs(item).forEach((need) => (FIGURES[need] ? gapsOf(item, need) : isKnownNumber(item[need]) ? [] : [inputName(need)]).forEach((gap) => gaps.push(gap)))
  spec.positive(item).forEach((divisor) => {
    if (!(Number(item[divisor]) > 0)) {
      gaps.push(isKnownNumber(item[divisor]) ? `${inputName(divisor)} above 0` : inputName(divisor))
    }
  })

  return [...new Set(gaps)]
}

// The stored keys a figure reads, followed down through the figures it builds on, and the rules it rests on.
const rootsOf = (item, key) => FIGURES[key].needs(item).flatMap((need) => (FIGURES[need] ? rootsOf(item, need) : [need]))

const rulesOf = (item, key) => [FIGURES[key].rule, ...FIGURES[key].needs(item).filter((need) => FIGURES[need]).flatMap((need) => rulesOf(item, need))]

// Works the figure `key` out of the item's stored values, or leaves it null when an input is missing.
const derive = (item, key, compute) => {
  item[key] = gapsOf(item, key).length ? null : compute(item)
}

// A derived figure of an item as a result: unavailable naming the inputs it lacks, otherwise at the weakest of its own rule and the rules it builds on.
export const figureResult = (item, key) => {
  const spec = FIGURES[key]
  const gaps = gapsOf(item, key)

  if (gaps.length) {
    return unavailable({ rule: spec.rule, missing: gaps })
  }

  return envelope({ value: item[key], status: weakestStatus(rulesOf(item, key).map((id) => getRule(id).verification)), rule: spec.rule, inputs: { present: [...new Set(rootsOf(item, key).concat(spec.positive(item)).map(inputName))] } })
}

// The component types whose stored ComponentValue is the figure they are built for, so it can be rated per hull space and per BP. `unit` names it where one category holds several types, and `scale` turns the stored value into that unit (a hangar stores hull spaces, a jump drive and a cloak the largest ship in hull spaces; each is shown in tons).
const MEASURES = {
  1: {},
  3: { unit: 'L of fuel' },
  4: { unit: 't of cargo' },
  5: { unit: 'MSP' },
  6: { unit: 'survey points / h' },
  7: { unit: 'survey points / h' },
  8: {},
  11: {},
  12: {},
  16: { scale: TONS_PER_HULL_SPACE },
  17: { unit: 'colonists' },
  18: {},
  22: {},
  24: {},
  25: {},
  26: { unit: 'damage control' },
  27: { unit: 't of troops' },
  41: {},
  43: { unit: 't of craft', scale: TONS_PER_HULL_SPACE },
  46: { scale: TONS_PER_HULL_SPACE },
  47: { unit: 'MSP' },
  50: { unit: 'passengers' },
  51: {},
  56: {},
  58: { unit: 't of craft', scale: TONS_PER_HULL_SPACE },
  59: { unit: 'damage control' },
  61: { unit: 'L of fuel / h' },
  63: { unit: 'MSP / h' },
  71: {},
}

const unit = (value, decimals = 0) => (item, f) => f.count(item[value], decimals)
const column = (text, value, format, extra = {}) => ({ text, value, numeric: true, format, ...extra })
const plain = (text, value, decimals = 0, extra = {}) => column(text, value, unit(value, decimals), extra)
const positive = (value) => (item) => !(item[value] > 0)

// A figure per hull space, with the same figure per ton as its tooltip. `tons` is the weight of one unit of the size.
const perSpace = (text, value, decimals, hint, { tons = TONS_PER_HULL_SPACE, extra = {} } = {}) => column(text, value, unit(value, decimals), {
  perHS: true,
  better: HIGH,
  hint,
  title: (item, f) => `${f.count(item[value] / tons, decimals + 2)} per ton`,
  ...extra,
})

// Build point costs run from hundredths to hundreds of thousands, so a figure per build point keeps three significant figures rather than a fixed number of decimals.
const significantDecimals = (value) => (value > 0 && value < 1 ? Math.min(6, Math.ceil(-Math.log10(value)) + 2) : value < 10 ? 2 : value < 100 ? 1 : 0)

// A figure per build point, which only Compare shows.
const perCost = (text, value, hint) => column(text, value, (item, f) => f.count(item[value], significantDecimals(item[value])), { compareOnly: true, better: HIGH, hint })

const timeText = (seconds, f) => (!isKnownNumber(seconds) ? UNKNOWN_TEXT : seconds < 60 ? `${f.count(seconds, 1)} s` : seconds < 3600 ? `${f.count(seconds / 60, 1)} min` : `${f.count(seconds / 3600, 1)} h`)

const materialsTitle = (item, f) => {
  const parts = MINERALS.filter((mineral) => item[mineral.name] > 0).map((mineral) => `${mineral.name} ${f.count(item[mineral.name], 2)}`)

  return parts.length ? `Materials: ${parts.join(', ')}` : ''
}

const sizeCostCrewHTK = [
  column('Size (t)', 'Size', (item, f) => f.count(item.Size * TONS_PER_HULL_SPACE, 2), { better: LOW, rule: TONNAGE, hint: 'Tons. One hull space is 50 tons.' }),
  column('Cost', 'Cost', unit('Cost', 2), { better: LOW, title: materialsTitle, hint: 'Build points. Hover a cost for its materials.' }),
  plain('Crew', 'Crew', 0, { better: LOW }),
  plain('HTK', 'HTK', 0, { better: HIGH, hint: 'Hits to kill. A hit of at least this much damage destroys the component and spends that much of itself on it; a smaller hit destroys it with a chance of damage / HTK and goes no further. At 0 or 1 any hit destroys it, and at 0 the whole hit carries on to the next component.' }),
]

const activeSensorColumns = [
  column('Range (mKm)', 'MaxSensorRange', (item, f) => f.count(item.MaxSensorRange / 1e6, 2), { better: HIGH, rule: UNIT_CONVERSION, hint: 'Against a target of Resolution × 50 tons or larger. A smaller target is seen at a shorter range.' }),
  plain('Resolution', 'Resolution'),
  plain('Strength', 'ComponentValue', 2, { better: HIGH, hint: 'The sensor strength of the whole component, its strength per hull space times its size.' }),
  perSpace('Strength / HS', 'MeasurePerHS', 2, 'Sensor strength per hull space: the strength of the sensor tech, the same at every size.'),
  perCost('Strength / BP', 'MeasurePerCost', 'Sensor strength per build point: what the electronic hardening and ECCM a design carries cost it.'),
]

const passiveSensorColumns = [
  plain('Sensitivity', 'ComponentValue', 2, { better: HIGH }),
  perSpace('Sensitivity / HS', 'MeasurePerHS', 2, 'Sensitivity per hull space: the sensitivity of the sensor tech, the same at every size.'),
  perCost('Sensitivity / BP', 'MeasurePerCost', 'Sensitivity per build point: what the electronic hardening a design carries costs it.'),
  ...SIGNATURES.map((signature) => column(`Range vs ${signature} (mKm)`, `Range${signature}`, (item, f) => f.count(item[`Range${signature}`] / 1e6, 2), { better: HIGH, hint: `Range against a target whose signature is ${signature}.` })),
]

const beamDamage = column('Damage', 'TotalDamage', unit('TotalDamage'), {
  better: HIGH,
  note: (item, f) => (item.NumberOfShots > 1 ? `${f.count(item.DamageOutput)} × ${f.count(item.NumberOfShots)}` : ''),
  hint: 'Damage a single firing does, shown as damage × shots when a firing has several.',
})
const beamRange = column('Range (km)', 'Range', unit('Range'), { better: HIGH })
const beamTracking = plain('Tracking speed (km/s)', 'TrackingSpeed', 0, { better: HIGH, skipZero: true, none: positive('TrackingSpeed') })
const beamDamagePerHS = perSpace('Damage / HS', 'DamagePerHS', 2, 'Damage a single firing does per hull space of the weapon.')
const beamRate = [
  column('Damage / s', 'DamagePerSecond', unit('DamagePerSecond', 2), { compareOnly: true, better: HIGH, hint: 'Damage a firing does over the seconds between firings, at point-blank range.' }),
  perSpace('Damage / s per HS', 'DamagePerSecondPerHS', 3, 'Damage per second per hull space of the weapon.'),
  perCost('Damage / s per BP', 'DamagePerSecondPerCost', 'Damage per second per build point.'),
]
const beamCapacitor = [
  column('Interval', 'Interval', (item, f) => `${f.count(item.Interval)} s`, { better: LOW, hint: 'Time between firings: the capacitor recharge time, in steps of 5 seconds.' }),
  plain('Power', 'PowerRequirement', 2, { hint: 'Power one firing takes from the capacitor.' }),
  plain('Capacitor', 'RechargeRate', 2, { hint: 'Power the capacitor recharges each step.' }),
]

const reloadColumns = [
  column('Hangar reload', 'HangarReload', (item, f) => `${f.count(item.HangarReload, 1)} min`, { better: LOW }),
  column('MF reload', 'MFReload', (item, f) => `${f.count(item.MFReload, 1)} h`, { better: LOW, hint: 'Reload at a maintenance facility.' }),
]

const explosionColumns = [
  plain('Max explosion', 'MaxExplosionSize', 0, { better: LOW }),
  column('Explosion chance', 'ExplosionChance', (item, f) => `${f.count(item.ExplosionChance, 1)}%`, { better: LOW }),
]

const fuelPerPower = column('Fuel per EP-hour (L)', 'FuelEfficiency', (item, f) => f.count(item.FuelEfficiency, item.FuelEfficiency >= 0.0005 ? 3 : 4), { better: LOW, hint: 'Litres of fuel the engine burns per engine-power-hour.' })

// What a design holds or does, named by the unit its component type counts it in, rated per hull space and per BP. `heading` names the figure ('Capacity'), `showUnit` puts the unit under it.
const measureColumns = (heading, { showUnit = true } = {}) => [
  column(heading, 'Measure', unit('Measure', 2), { better: HIGH, note: (item) => (showUnit ? item.MeasureUnit : '') }),
  perSpace(`${heading} / HS`, 'MeasurePerHS', 2, `${heading} per hull space.`),
  perCost(`${heading} / BP`, 'MeasurePerCost', `${heading} per build point.`),
]

const optional = (value, decimals = 2) => column('', value, (item, f) => f.count(item[value], decimals), { none: positive(value) })
const missileValue = (text, value, extra = {}) => ({ ...optional(value), text, better: HIGH, ...extra })

const speciesRange = (item, f, value, deviation, decimals, offset = 0) => `${f.count(item[value] - item[deviation] - offset, decimals)} – ${f.count(item[value] + item[deviation] - offset, decimals)}`

const nameColumn = { text: 'Name', value: 'Name', numeric: false }

// A column's `better` is the side a design taken alone wants: more damage, range, strength, capacity, power and hit points; less size, cost, crew, reload time, fuel burn, explosion risk and cloak rating (the share of a ship's signature that still shows). A figure has no better side when it is a trade-off or a requirement rather than a quality: a sensor's resolution, a beam's power and capacitor draw (what it pays for its damage), the missile or decoy size a launcher takes, a pod's size, and a species' tolerances. A raw total grows with size, so a bigger design wins the output and loses the cost; the per hull space and per BP figures are the ones that rank designs of different sizes.
export const categoryColumnsMap = {
  1: [...measureColumns('Strength', { showUnit: false }), ...sizeCostCrewHTK],
  13: [...activeSensorColumns, ...sizeCostCrewHTK],
  24: [...activeSensorColumns, ...sizeCostCrewHTK],
  23: [plain('Range (km)', 'ComponentValue', 0, { better: HIGH }), plain('Tracking speed (km/s)', 'TrackingSpeed', 0, { better: HIGH }), ...sizeCostCrewHTK],
  43: [
    column('ROF', 'ComponentValue', (item, f) => `${f.count(item.ComponentValue)} / 5 s`, { better: HIGH, hint: 'Shots every five seconds.' }),
    perSpace('ROF / HS', 'MeasurePerHS', 2, 'Shots every five seconds per hull space of the whole mount: cannon, turret, fire control and sensor.'),
    plain('Tracking speed (km/s)', 'TrackingSpeed', 0, { better: HIGH }),
    plain('ECCM', 'ECCM', 0, { better: HIGH }),
    ...sizeCostCrewHTK,
  ],
  41: [
    column('Cloak rating', 'CloakRating', unit('CloakRating', 3), { better: LOW, hint: 'The share of its signature a ship under the cloak keeps: 0.07 hides 93% of it.' }),
    column('Max ship size (HS)', 'ComponentValue', unit('ComponentValue'), { better: HIGH, rule: TONNAGE, note: (item, f) => `${f.count(item.ComponentValue * TONS_PER_HULL_SPACE)} t` }),
    perSpace('Ship size / HS (t)', 'MeasurePerHS', 2, 'Tons of ship the cloak hides per hull space of the device.'),
    ...sizeCostCrewHTK,
  ],
  51: [
    plain('Max decoy size', 'ComponentValue'),
    perSpace('Decoy size / HS', 'MeasurePerHS', 2, 'Largest decoy per hull space of the launcher.'),
    ...reloadColumns,
    ...sizeCostCrewHTK,
  ],
  49: [plain('Pod size', 'ComponentValue'), ...reloadColumns, ...sizeCostCrewHTK],
  34: [...passiveSensorColumns, ...sizeCostCrewHTK],
  14: [...passiveSensorColumns, ...sizeCostCrewHTK],
  7: [
    plain('Power', 'ComponentValue', 1, { better: HIGH }),
    perSpace('Power / HS', 'MeasurePerHS', 2, 'Engine power per hull space.'),
    perCost('Power / BP', 'MeasurePerCost', 'Engine power per build point.'),
    fuelPerPower,
    ...explosionColumns,
    ...sizeCostCrewHTK,
  ],
  39: [
    beamDamage,
    beamRange,
    beamTracking,
    column('ROF', 'NumberOfShots', (item, f) => `${f.count(item.NumberOfShots)} / 5 s`, { better: HIGH, hint: 'Shots every five seconds.' }),
    beamDamagePerHS,
    ...beamRate,
    ...sizeCostCrewHTK,
  ],
  35: [beamDamage, beamRange, ...beamCapacitor, beamDamagePerHS, ...beamRate, ...sizeCostCrewHTK],
  22: [
    column('Capacity (t)', 'ComponentValue', (item, f) => f.count(item.ComponentValue * TONS_PER_HULL_SPACE), { better: HIGH, rule: TONNAGE, hint: 'The largest ship the drive jumps alone.' }),
    plain('Squadron', 'JumpRating', 0, { better: HIGH, hint: 'The most ships it jumps together as a squadron.' }),
    plain('Distance (k km)', 'JumpDistance', 0, { better: HIGH }),
    perSpace('Capacity / HS (t)', 'MeasurePerHS', 2, 'Tons of ship the drive jumps per hull space of the drive.'),
    perCost('Capacity / BP (t)', 'MeasurePerCost', 'Tons of ship the drive jumps per build point.'),
    ...sizeCostCrewHTK,
  ],
  2: [beamDamage, beamRange, beamTracking, ...beamCapacitor, beamDamagePerHS, ...beamRate, ...sizeCostCrewHTK],
  42: [
    plain('Capacity', 'ComponentValue', 0, { better: HIGH, hint: 'Missile size, in MSP, the magazine holds.' }),
    column('Capacity per HS', 'MeasurePerHS', unit('MeasurePerHS', 2), { better: HIGH, title: (item, f) => `${f.count(item.MeasurePerHS / TONS_PER_HULL_SPACE, 4)} per ton` }),
    perCost('Capacity / BP', 'MeasurePerCost', 'Missile size, in MSP, held per build point.'),
    ...sizeCostCrewHTK,
  ],
  27: [beamDamage, beamRange, beamTracking, ...beamCapacitor, beamDamagePerHS, ...beamRate, ...sizeCostCrewHTK],
  50: sizeCostCrewHTK,
  3: [
    column('Missile size (MSP)', 'ComponentValue', unit('ComponentValue', 2), { rule: TONNAGE, note: (item, f) => `${f.count(item.ComponentValue * TONS_PER_MSP, 2)} t` }),
    perSpace('Missile size / HS', 'MeasurePerHS', 2, 'Largest missile, in MSP, per hull space of the launcher.'),
    column('Reload', 'RateOfFire', (item, f) => (item.HangarReloadOnly ? `${f.count(item.HangarReload, 1)} min` : timeText(item.RateOfFire, f)), {
      better: LOW,
      rule: 'designedTech.reload',
      needs: ['HangarReloadOnly'],
      note: (item, f) => (item.HangarReloadOnly ? 'Hangar only' : item.RateOfFire >= 60 ? `${f.count(item.RateOfFire)} s` : ''),
      hint: 'A launcher marked hangar only reloads in a hangar deck.',
    }),
    ...sizeCostCrewHTK,
  ],
  4: [
    column('Size (MSP)', 'Size', unit('Size', 2), { better: LOW, rule: TONNAGE, note: (item, f) => `${f.count(item.Size * TONS_PER_MSP, 2)} t` }),
    plain('Speed (km/s)', 'Speed', 0, { better: HIGH }),
    column('First stage (mKm)', 'MaxRange', (item, f) => f.count(item.MaxRange / 1e6, 2), { better: HIGH, rule: UNIT_CONVERSION, title: (item, f) => `Endurance ${timeText(item.Endurance, f)}, fuel ${f.count(item.FuelRequired)} L` }),
    column('Total range (mKm)', 'TotalRange', (item, f) => f.count(item.TotalRange / 1e6, 2), {
      better: HIGH,
      title: (item, f) => (item.SecondStageID ? `First stage ${f.count(item.MaxRange / 1e6, 2)} mKm, second stage ${f.count(item.SecondStageMaxRange / 1e6, 2)} mKm, separating at ${f.count(item.SeparationRange)} km` : 'Single stage'),
    }),
    column('Warhead', 'WarheadStrength', unit('WarheadStrength', 2), { better: HIGH, note: (item, f) => (item.MultipleWarheads > 1 ? `${f.count(item.MultipleWarheads)} warheads` : '') }),
    perSpace('Warhead / MSP', 'WarheadPerMSP', 3, 'Warhead strength, all its warheads together, per MSP of the missile. A ship decoy has none.', { tons: TONS_PER_MSP }),
    column('Warhead / BP', 'WarheadPerCost', unit('WarheadPerCost', 3), { compareOnly: true, better: HIGH, hint: 'Warhead strength, all its warheads together, per build point. A ship decoy has none.' }),
    missileValue('Active', 'SensorStrength', { title: (item, f) => (item.SensorStrength > 0 ? `Resolution ${f.count(item.SensorResolution)}, range ${f.count(item.SensorRange / 1e6, 2)} mKm` : '') }),
    missileValue('Thermal', 'ThermalStrength'),
    missileValue('EM', 'EMStrength'),
    missileValue('Geo', 'Geostrength'),
    missileValue('Decoys', 'NumDecoys'),
    missileValue('ECCM', 'ECCM'),
    column('ATG', 'ATG', (item, f) => `+${f.count((item.ATG - 1) * 100)}%`, { better: HIGH, rule: UNIT_CONVERSION, none: (item) => !(item.ATG > 1), hint: 'Active terminal guidance, shown as its bonus over 1.' }),
    { text: 'Retargeting', value: 'Retargeting', numeric: false, format: () => 'Yes', none: (item) => !item.Retargeting },
    missileValue('Radiation', 'RadDamage'),
    column('Cost', 'Cost', unit('Cost', 2), { better: LOW, title: materialsTitle }),
    { text: 'Second stage', value: 'SecondStage', numeric: false, needs: ['SecondStageID', 'SecondStage'], gaps: (item) => (isKnownNumber(item.SecondStageID) ? [] : [inputName('SecondStageID')]), format: (item) => item.SecondStage, none: (item) => !item.SecondStageID },
  ],
  47: [
    { text: 'Breathes', value: 'GasName', numeric: false, format: (item) => item.GasName, none: (item) => !item.GasName },
    column('Gravity (G)', 'Gravity', unit('Gravity', 2), { needs: ['GravDev'], note: (item, f) => speciesRange(item, f, 'Gravity', 'GravDev', 2) }),
    column('Temperature (°C)', 'Temperature', (item, f) => f.count(item.Temperature - KELVIN_TO_CELSIUS, 1), { needs: ['TempDev'], rule: UNIT_CONVERSION, note: (item, f) => speciesRange(item, f, 'Temperature', 'TempDev', 1, KELVIN_TO_CELSIUS) }),
    column('Oxygen (atm)', 'Oxygen', unit('Oxygen', 2), { needs: ['OxyDev'], note: (item, f) => speciesRange(item, f, 'Oxygen', 'OxyDev', 2) }),
    plain('Max atmosphere (atm)', 'PressMax', 2),
  ],
  26: [beamDamage, beamRange, ...beamCapacitor, beamDamagePerHS, ...beamRate, ...sizeCostCrewHTK],
  29: [beamDamage, beamRange, ...beamCapacitor, beamDamagePerHS, ...beamRate, ...sizeCostCrewHTK],
  5: [
    plain('Power', 'ComponentValue', 1, { better: HIGH }),
    column('Power per HS', 'MeasurePerHS', unit('MeasurePerHS', 2), { better: HIGH, title: (item, f) => `${f.count(item.MeasurePerHS / TONS_PER_HULL_SPACE, 4)} per ton` }),
    ...explosionColumns,
    ...sizeCostCrewHTK,
  ],
  28: [beamDamage, beamRange, ...beamCapacitor, beamDamagePerHS, ...beamRate, ...sizeCostCrewHTK],
  12: [
    plain('Strength', 'ComponentValue', 2, { better: HIGH }),
    plain('Recharge time (s)', 'RechargeRate', 1, { better: LOW }),
    column('Per second', 'ShieldPerSecond', unit('ShieldPerSecond', 2), { better: HIGH, hint: 'Shield strength restored each second: strength over recharge time.' }),
    perSpace('Strength / HS', 'MeasurePerHS', 2, 'Shield strength per hull space.'),
    perSpace('Per second / HS', 'ShieldPerSecondPerHS', 3, 'Shield strength restored each second, per hull space.'),
    perCost('Strength / BP', 'MeasurePerCost', 'Shield strength per build point.'),
    ...sizeCostCrewHTK,
  ],
  30: [...measureColumns('Output'), ...sizeCostCrewHTK],
  48: [
    plain('Power', 'ComponentValue', 2, { better: HIGH }),
    perSpace('Power / MSP', 'MeasurePerHS', 2, 'Missile engine power per MSP of the engine.', { tons: TONS_PER_MSP }),
    perCost('Power / BP', 'MeasurePerCost', 'Missile engine power per build point.'),
    fuelPerPower,
    column('Size (MSP)', 'Size', unit('Size', 2), { better: LOW, rule: TONNAGE, note: (item, f) => `${f.count(item.Size * TONS_PER_MSP, 2)} t` }),
    column('Cost', 'Cost', unit('Cost', 2), { better: LOW, title: materialsTitle, hint: 'Build points. Hover a cost for its materials.' }),
  ],
  11: [...measureColumns('Capacity'), ...sizeCostCrewHTK],
  31: [...measureColumns('Capacity'), ...sizeCostCrewHTK],
  32: [...measureColumns('Capacity'), ...sizeCostCrewHTK],
}

// Categories without an entry above show the columns every component has.
export const columnsFor = (categoryId) => [nameColumn, ...(categoryColumnsMap[categoryId] || sizeCostCrewHTK)]

// What the rules say under a category's table, besides the general line.
const CATEGORY_NOTES = {
  1: 'A ship\'s armour takes its armour volume divided by the strength of the armour, in hull spaces, so strength per hull space is the strength itself and strength per BP is how much armour a build point buys.',
  13: 'An active sensor sees a target of Resolution × 50 tons or larger out to its range; a smaller one only closer in. Strength is the sensor tech\'s strength per hull space times the size, so strength per hull space is the same at every size of one tech. Range grows with the square root of strength, so range per hull space is not shown; a lower resolution sees smaller targets and a higher one holds its range on larger ones, so neither is better. Strength per BP prices the electronic hardening and ECCM a design carries.',
  24: 'A missile fire control has twice the range of an active sensor of the same strength and size. Its range is for a target of Resolution × 50 tons or larger. Strength per hull space and per BP are worked out as for an active sensor, and resolution has no better side.',
  34: 'A passive sensor sees a signature out to √(sensitivity × signature) × 250,000 km. Sensitivity is the sensor tech\'s sensitivity per hull space times the size, so sensitivity per hull space is the same at every size of one tech. Range grows with the square root of sensitivity, so range per hull space is not shown. Sensitivity per BP prices the electronic hardening a design carries.',
  14: 'A passive sensor sees a signature out to √(sensitivity × signature) × 250,000 km. Sensitivity is the sensor tech\'s sensitivity per hull space times the size, so sensitivity per hull space is the same at every size of one tech. Range grows with the square root of sensitivity, so range per hull space is not shown. Sensitivity per BP prices the electronic hardening a design carries.',
  7: 'Engine power is the engine tech times its size times its thrust modifier, so power per hull space is the tech and the thrust modifier together. The explosion chance is 10% per point of thrust modifier, and the largest explosion is a quarter of its power. An engine\'s cost is half its power, less with a thrust modifier under 1 and more with thermal signature reduction, so power per BP shows what a design pays for those. Fuel per engine-power-hour rises with the thrust modifier and falls as the engine grows.',
  5: 'Power per hull space is the power output over the size in hull spaces. A designed reactor\'s output is its tech times its size times √size times its boost, so a larger reactor gives more per hull space. Its cost is three times its output, so power per BP would not tell designed reactors apart and is not shown.',
  42: 'Capacity per hull space is the magazine capacity over its size in hull spaces. A magazine gives up capacity to its internal armour, which also adds cost; capacity per BP prices that.',
  22: 'A jump drive is commercial only if it is built as a commercial drive; any other kind is commercial when it is not a military system. Capacity per hull space is the ship size the drive jumps per hull space of drive (the game\'s max ship size against drive size ratio). A drive\'s size grows more slowly than the ship it moves, so larger drives give more per hull space.',
  4: 'Total range is the first stage plus the second stage\'s own range; a second stage that has a stage of its own is not followed further. A missile is 2.5 tons per MSP. A missile or species is not mounted on a class, so it has no Used on figures. Warhead is the strength of all a missile\'s warheads together, so warhead per MSP and per BP rate the damage a missile carries by the magazine space and the cost it takes. A ship decoy\'s warhead is a signature, not damage, and has no such figure. The hit chance scenarios below the table set the missiles against a target speed, a missile jammer and a tactical modifier.',
  47: 'A species lives within its ideal value plus or minus its deviation, which is the range shown under each figure. Temperatures are in °C, which is the Kelvin value minus 273. A species has no better side in any figure.',
  43: 'Shots per hull space counts the whole mount: the cannon, its turret, its fire control and its sensor.',
  41: 'A cloak rating is the share of a ship\'s signature that still shows under the cloak, so 0.07 hides 93% of it and a lower rating is better. Ship size per hull space is the cloak tech\'s efficiency; a device\'s cost grows with the square of its size.',
  3: 'A launcher\'s size is the missile size it takes times its size modifier, so missile size per hull space is one over that modifier. A box launcher (a modifier under 0.3) reloads only in a hangar deck. The largest missile a launcher takes has no better side: it is the missile the launcher is meant to fire.',
  51: 'A decoy launcher is sized as a box launcher, a tenth of a hull space per unit of decoy size, so decoy size per hull space is 10. The largest decoy it takes has no better side.',
  12: 'A shield generator\'s strength is the tech times its size times √(size ÷ 10), so strength per hull space rises with size. Its cost is its strength plus its recharge rate, so strength per BP prices the recharge too. Per second is strength over recharge time.',
  48: 'A missile engine is sized in MSP (2.5 tons each), not hull spaces. Its power is the engine tech times its size times its thrust modifier, and its cost is half its power (less with a thrust modifier under 1).',
  30: 'Output is the survey points a sensor gathers each hour.',
  11: 'Capacity is in the unit each design names under it: litres of fuel, MSP of maintenance supplies, litres or MSP an hour for a transfer system, damage control. A design with no such figure shows —. Compare ranks designs only against designs of the same component type, so a fuel tank is never set against a transfer system.',
  31: 'Capacity is in the unit each design names under it: tons of cargo, colonists or passengers, tons of craft for a hangar deck. A design with no such figure shows —. Compare ranks designs only against designs of the same component type.',
  32: 'Capacity is the tons of troops a bay carries.',
}

const BEAM_NOTE = 'A beam weapon\'s range is its fixed maximum when it has one, and otherwise its damage times its range modifier. It fires every ⌈power ÷ capacitor recharge⌉ steps of 5 seconds, or every step when it needs no power. Damage per hull space counts one firing. Damage per second is a firing\'s damage over the seconds between firings, at point-blank range, and is rated per hull space and per BP. The power a firing takes and the capacitor recharge have no better side: they are what the weapon pays for its damage.'
const GAUSS_NOTE = 'A gauss cannon fires its shots every 5 seconds. Its range is its fixed maximum when it has one, and otherwise its damage times its range modifier. Damage per hull space counts one firing. Damage per second is a firing\'s damage over 5 seconds, at point-blank range, and is rated per hull space and per BP.'

export const categoryNote = (categoryId) => (categoryId === 39 ? GAUSS_NOTE : BEAM_CATEGORY_IDS.includes(categoryId) ? BEAM_NOTE : CATEGORY_NOTES[categoryId] || '')

export const isCommercial = (item) => (item.ComponentTypeID === JUMP_DRIVE_TYPE_ID ? item.SpecialFunction === COMMERCIAL_JUMP_FUNCTION : !item.MilitarySystem)

// Every component read from the save, with the figures its category derives from the stored values.
export const augmentComponent = (component) => {
  const item = component
  const categoryId = item.CategoryID

  item.Baseline = !!item.Baseline
  item.ObsoleteKnown = isKnownNumber(item.Obsolete)
  item.Obsolete = !!item.Obsolete
  item.Commercial = isCommercial(item)
  item.Civilian = !!item.ShippingLineSystem

  const measure = MEASURES[item.ComponentTypeID]

  if (measure) {
    item.MeasureUnit = measure.unit || ''
    derive(item, 'Measure', () => item.ComponentValue * (measure.scale || 1))
    derive(item, 'MeasurePerHS', () => item.Measure / item.Size)
    derive(item, 'MeasurePerCost', () => item.Measure / item.Cost)
  }

  if (BEAM_CATEGORY_IDS.includes(categoryId)) {
    derive(item, 'TotalDamage', () => item.DamageOutput * item.NumberOfShots)
    derive(item, 'Range', () => (item.MaxWeaponRange > 0 ? item.MaxWeaponRange : item.DamageOutput * Math.trunc(item.RangeModifier)))
    derive(item, 'Interval', () => (item.PowerRequirement === 0 ? 1 : Math.ceil(item.PowerRequirement / item.RechargeRate)) * 5)
    derive(item, 'DamagePerHS', () => item.TotalDamage / item.Size)
    derive(item, 'DamagePerSecond', () => item.TotalDamage / item.Interval)
    derive(item, 'DamagePerSecondPerHS', () => item.DamagePerSecond / item.Size)
    derive(item, 'DamagePerSecondPerCost', () => item.DamagePerSecond / item.Cost)
  } else if (PASSIVE_CATEGORY_IDS.includes(categoryId)) {
    SIGNATURES.forEach((signature) => derive(item, `Range${signature}`, () => Math.sqrt(item.ComponentValue * signature) * 250000))
  } else if (categoryId === 12) {
    derive(item, 'ShieldPerSecond', () => (item.RechargeRate > 0 ? item.ComponentValue / item.RechargeRate : 0))
    derive(item, 'ShieldPerSecondPerHS', () => item.ShieldPerSecond / item.Size)
  }

  if (categoryId === 51 || categoryId === 49 || categoryId === 3) {
    derive(item, 'HangarReload', () => item.RateOfFire / 60)
    derive(item, 'MFReload', () => item.RateOfFire / 360)
  }

  return item
}

export const augmentMissile = (missile) => {
  const item = missile

  item.SDComponentID = `missile-${item.MissileID}`
  item.CategoryID = MISSILE_CATEGORY_ID
  item.MilitarySystem = 1
  item.ObsoleteKnown = isKnownNumber(item.Obsolete)
  item.Obsolete = !!item.Obsolete
  item.Baseline = false
  item.Commercial = false
  item.Civilian = false
  item.ShipDecoy = isKnownNumber(item.ShipDecoy) ? !!item.ShipDecoy : null
  derive(item, 'TotalRange', () => item.MaxRange + (item.SecondStageID ? item.SecondStageMaxRange : 0))
  item.SecondStage = !isKnownNumber(item.SecondStageID) ? null : item.SecondStageID ? (isKnownNumber(item.NumSS) && item.SecondStageName ? `${item.NumSS} × ${item.SecondStageName}` : null) : ''
  derive(item, 'WarheadPerMSP', () => (item.ShipDecoy ? 0 : item.WarheadStrength / item.Size))
  derive(item, 'WarheadPerCost', () => (item.ShipDecoy ? 0 : item.WarheadStrength / item.Cost))

  return item
}

export const augmentSpecies = (species) => {
  const item = species

  item.SDComponentID = `species-${item.SpeciesID}`
  item.CategoryID = SPECIES_CATEGORY_ID
  item.MilitarySystem = 1
  item.ObsoleteKnown = true
  item.Obsolete = !!item.Obsolete
  item.Baseline = false
  item.Commercial = false
  item.Civilian = false

  return item
}

// Whether a component can be mounted on a class, which a missile type or a species cannot.
export const isMountable = (item) => item.CategoryID !== MISSILE_CATEGORY_ID && item.CategoryID !== SPECIES_CATEGORY_ID

// What marks a design beyond its kind. Every ship component is military or commercial: the name's second line names only a commercial one, as the row's icon tells them apart, and `role` names a military one too.
export const tagsOf = (item, { role = false } = {}) => {
  const tags = []

  if (item.Baseline) {
    tags.push('Baseline')
  }

  if (item.TurretWeaponID) {
    tags.push('Turret')
  }

  if (item.SpinalWeapon) {
    tags.push('Spinal')
  }

  if (isMountable(item) && (role || item.Commercial)) {
    tags.push(item.Commercial ? 'Commercial' : 'Military')
  }

  if (item.Civilian) {
    tags.push('Civilian')
  }

  if (PROTOTYPES[item.Prototype]) {
    tags.push(PROTOTYPES[item.Prototype])
  }

  return tags
}

// A value the save left empty or that does not work out as a number; a key the item does not have at all (undefined) means the design has no such figure, which is not the same.
const isUnknown = (value) => value === null || (typeof value === 'number' && !Number.isFinite(value))

const USAGE = 'designedTech.usage'

// The usage columns of a design a class can mount. A figure left unknown reads — with its mark, while a design on no class reads a known 0.
export const USAGE_COLUMNS = [
  { text: 'Classes', value: 'classCount', numeric: true, showZero: true, rule: USAGE, gaps: (item) => item.usageGaps, format: (item, f) => f.count(item.classCount), hint: 'Classes of the race that mount it, obsolete classes included.' },
  { text: 'Ships', value: 'shipCount', numeric: true, showZero: true, rule: USAGE, gaps: (item) => item.usageGaps, format: (item, f) => f.count(item.shipCount), hint: 'Ships of those classes still in service.' },
]

// The rule a column's header mark names: its own, or the rule of the figure it shows.
export const columnRule = (column) => column.rule || (FIGURES[column.value] ? FIGURES[column.value].rule : null)

// The text, note, tooltip and provenance of one cell. `none` is a cell the design has no figure for (shown —, no mark); `unknown` a figure the save leaves out (shown — with `result` naming what is missing). A derived figure carries its result either way.
const NO_FIGURE = Object.freeze({ text: UNKNOWN_TEXT, note: '', title: '', none: true, unknown: false, result: null })

export const cellOf = (column, item, f) => {
  const value = item[column.value]
  const derived = Boolean(FIGURES[column.value])

  if (derived && value === undefined) {
    return NO_FIGURE
  }

  const result = derived ? figureResult(item, column.value) : null
  const unknownCell = (own) => ({ text: UNKNOWN_TEXT, note: '', title: '', none: true, unknown: true, result: own })

  if (derived && !isAvailable(result)) {
    return unknownCell(result)
  }

  if (!derived) {
    const keys = [...(column.numeric === false ? [] : [column.value]), ...(column.needs || [])].filter((key) => isUnknown(item[key]))

    if (keys.length) {
      const gaps = (column.gaps && column.gaps(item)) || []

      return unknownCell(unavailable({ rule: column.rule === USAGE ? USAGE : STORED, missing: gaps.length ? gaps : keys.map((key) => (key === column.value ? column.text : inputName(key))) }))
    }
  }

  const none = column.none ? column.none(item) : value == null || (column.numeric && value === 0 && !column.showZero)

  return none ? NO_FIGURE : { text: column.format(item, f), note: column.note ? column.note(item, f) : '', title: column.title ? column.title(item, f) : '', none: false, unknown: false, result }
}

const nullLast = (a, b) => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : 0)

// A figure the table has none of (null, undefined) or that does not work out as a number (NaN): it reads — and sorts after every other value, in either direction.
const isGap = (value) => value === null || value === undefined || (typeof value === 'number' && Number.isNaN(value))

// Vuetify's `custom-sort` for the designs table: sorts by each of `sortBy` in turn, the designs without the figure last whichever way it runs, never as 0.
export const sortRows = (items, sortBy, sortDesc) => {
  if (!sortBy.length) {
    return items
  }

  return [...items].sort((a, b) => {
    for (let index = 0; index < sortBy.length; index += 1) {
      const x = a[sortBy[index]]
      const y = b[sortBy[index]]

      if (isGap(x) || isGap(y)) {
        if (isGap(x) !== isGap(y)) {
          return isGap(x) ? 1 : -1
        }

        continue
      }

      const order = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : Number(x) - Number(y)

      if (order) {
        return order * (sortDesc[index] ? -1 : 1)
      }
    }

    return 0
  })
}

// Per design, the classes of the race that mount it (each with how many it mounts per ship, the ships in service and whether the class is obsolete), from the class component rows. A mount without a design or a class id is counted apart: it cannot be given to any design.
export const classUsageByComponent = (rows) => {
  const byComponent = new Map()
  let unattributed = 0

  rows.forEach((row) => {
    if (row.ComponentID == null || row.ClassID == null) {
      unattributed += 1

      return
    }

    let classes = byComponent.get(row.ComponentID)

    if (!classes) {
      classes = new Map()
      byComponent.set(row.ComponentID, classes)
    }

    const perShip = isKnownNumber(row.NumComponent) ? row.NumComponent : null
    const existing = classes.get(row.ClassID)

    if (existing) {
      existing.perShip = existing.perShip === null || perShip === null ? null : existing.perShip + perShip
    } else {
      classes.set(row.ClassID, { id: row.ClassID, name: row.ClassName == null ? `Class ${row.ClassID}` : row.ClassName, perShip, ships: isKnownNumber(row.Ships) ? row.Ships : null, obsolete: isKnownNumber(row.Obsolete) ? !!row.Obsolete : null })
    }
  })

  return { byComponent, unattributed }
}

// A design with its usage: the classes that mount it, most ships first with a class whose ships are unknown last, and the class and ship counts. A design a class cannot mount has none; counts are null, never 0, where a class mount could not be attributed or a class has no ship count, and `usageGaps` names what is missing.
export const withUsage = (item, usage) => {
  if (!isMountable(item)) {
    return { ...item, classes: [], classCount: null, shipCount: null, usageGaps: ['a design of this kind is never mounted'] }
  }

  const classes = usage.byComponent.has(item.SDComponentID) ? [...usage.byComponent.get(item.SDComponentID).values()].sort((a, b) => nullLast(a.ships, b.ships) || b.ships - a.ships || a.name.localeCompare(b.name)) : []
  const gaps = []

  if (usage.unattributed > 0) {
    gaps.push(`${usage.unattributed} class mounts without a design or a class`)
  }

  if (classes.some((shipClass) => shipClass.ships === null)) {
    gaps.push(`the ships of ${classes.filter((shipClass) => shipClass.ships === null).length} classes`)
  }

  const attributed = usage.unattributed === 0

  return { ...item, classes, classCount: attributed ? classes.length : null, shipCount: attributed && !gaps.length ? classes.reduce((total, shipClass) => total + shipClass.ships, 0) : null, usageGaps: gaps }
}

// Whether a design is on no class: false where its usage is unknown.
export const isUnused = (row) => row.classCount === 0

// The tiles of the Designed page: each with its result (provenance), a note and the counts in the unknowns. `rows` are the category's designs with their usage before the filters, `shown` how many the filters leave, `f` a { count } formatter.
export const designTiles = ({ rows, shown, mountable, f }) => {
  const total = rows.length
  const designs = ofRule({ rule: 'designedTech.count', value: total })

  const counted = (rule, known, value, what) => {
    if (known.length === total) {
      return ofRule({ rule, value })
    }

    return known.length ? envelope({ status: STATUS.ESTIMATED, value, rule, inputs: { present: [`${known.length} designs`], missing: [`${what} of ${total - known.length} designs`] } }) : unavailable({ rule, missing: [`${what} of ${total} designs`] })
  }

  const designsTile = { label: 'Designs', result: designs, note: `All in the category; ${f.count(shown)} listed with the filters` }
  const obsoleteKnown = rows.filter((row) => row.ObsoleteKnown)
  const obsolete = counted('designedTech.obsolete', obsoleteKnown, obsoleteKnown.filter((row) => row.Obsolete).length, 'the obsolete flag')
  const obsoleteNote = `Filters ignored · marked obsolete by the race${obsoleteKnown.length < total ? `; ${f.count(total - obsoleteKnown.length)} without a flag` : ''}`

  if (!mountable) {
    const never = (rule) => unavailable({ rule, missing: ['a missile type or a species is never mounted on a class'] })

    return [designsTile, { label: 'In use', result: never('designedTech.inUse'), note: 'Not mounted on a class' }, { label: 'Unused', result: never('designedTech.unused'), note: 'Not mounted on a class' }, { label: 'Obsolete', result: obsolete, note: obsoleteNote }]
  }

  const known = rows.filter((row) => row.classCount !== null)
  const used = known.filter((row) => row.classCount > 0)
  const unused = known.filter((row) => row.classCount === 0)
  const inUse = counted('designedTech.inUse', known, used.length, 'the classes that mount it')
  const unusedResult = counted('designedTech.unused', known, unused.length, 'the classes that mount it')
  const shipsByClass = new Map(used.flatMap((row) => row.classes.map((shipClass) => [shipClass.id, shipClass.ships])))
  const shipsKnown = [...shipsByClass.values()].filter((ships) => ships !== null)
  const shipTotal = shipsKnown.reduce((sum, ships) => sum + ships, 0)
  const shipGaps = []

  if (known.length < total) {
    shipGaps.push(`the classes of ${total - known.length} designs`)
  }

  if (shipsKnown.length < shipsByClass.size) {
    shipGaps.push(`the ships of ${shipsByClass.size - shipsKnown.length} classes`)
  }

  const ships = shipGaps.length ? (known.length || shipsKnown.length ? envelope({ status: STATUS.ESTIMATED, value: shipTotal, rule: 'designedTech.shipCount', inputs: { present: [`${shipsKnown.length} classes`], missing: shipGaps } }) : unavailable({ rule: 'designedTech.shipCount', missing: shipGaps })) : ofRule({ rule: 'designedTech.shipCount', value: shipTotal })
  const shipsText = isAvailable(ships) ? f.count(ships.value) : UNKNOWN_TEXT
  const stillOn = known.filter((row) => row.Obsolete && row.classCount > 0).length

  return [
    designsTile,
    { label: 'In use', result: inUse, results: [inUse, ships], note: `Filters ignored · on ${f.count(shipsByClass.size)} classes, ${shipsText} ships${shipGaps.length ? ` (${shipGaps.join(', ')} unknown)` : ''}` },
    { label: 'Unused', result: unusedResult, note: `Filters ignored · ${f.count(unused.filter((row) => !row.Obsolete).length)} not obsolete` },
    { label: 'Obsolete', result: obsolete, note: `${obsoleteNote} · ${f.count(stillOn)} still on a class` },
  ]
}

// The best and worst marks of one compared figure, and the verdict as a result. `cells` are the `cellOf` cells of the designs picked, `names` their names. A design without the figure (unknown) takes no part and is named; a design that has none by nature (a zero of a figure that skips zero) takes no part either. Marks go only among designs with a figure, so with fewer than two there is no verdict.
export const compareMarks = (column, rows, cells, differs) => {
  const blank = () => ({ mark: null, verdict: null, markTitle: '' })
  const out = { marks: rows.map(blank), verdict: null, note: '' }

  if (!column.numeric) {
    return out
  }

  const unknownAt = cells.map((cell) => cell.unknown)
  const values = rows.map((row, index) => {
    const raw = row[column.value]
    const value = unknownAt[index] || raw == null ? NaN : Number(raw)

    return Number.isFinite(value) && !(column.skipZero && value === 0) ? value : null
  })

  const present = values.filter((value) => value !== null)
  const unknownNames = rows.filter((_row, index) => unknownAt[index]).map((row) => row.Name)

  if (!unknownNames.length && (!differs || present.length < 2 || Math.max(...present) === Math.min(...present))) {
    return out
  }

  const statuses = [...cells.filter((cell) => cell.result && isAvailable(cell.result)).map((cell) => cell.result.status), ...(columnRule(column) ? [getRule(columnRule(column)).verification] : [])]
  const names = rows.filter((_row, index) => values[index] !== null).map((row) => row.Name)
  const high = Math.max(...present)
  const low = Math.min(...present)

  if (present.length < 2 || high === low) {
    out.verdict = unavailable({ rule: COMPARE_VERDICT, present: names, missing: unknownNames.map((name) => `the figure of ${name}`) })
    out.note = `No best or worst: only ${present.length} of ${rows.length} designs ${present.length === 1 ? 'has' : 'have'} a figure`

    return out
  }

  if (unknownNames.length) {
    out.verdict = envelope({ status: weakestStatus([STATUS.ESTIMATED, ...statuses]), value: present.length, rule: COMPARE_VERDICT, inputs: { present: names, missing: unknownNames.map((name) => `the figure of ${name}`) } })
    out.note = `Ranked among ${present.length} of ${rows.length} designs; ${unknownNames.length} ${unknownNames.length === 1 ? 'has' : 'have'} no figure`
  } else {
    out.verdict = envelope({ status: weakestStatus([STATUS.CONFIRMED, ...statuses]), value: present.length, rule: COMPARE_VERDICT, inputs: { present: names } })
  }

  const directed = Boolean(column.better) && rows.every((row) => row.ComponentTypeID === rows[0].ComponentTypeID)

  out.marks = values.map((value) => {
    if (value === null || (value !== high && value !== low)) {
      return blank()
    }

    const mark = value === high ? 'high' : 'low'

    if (!directed) {
      return { mark, verdict: null, markTitle: mark === 'high' ? 'Highest value' : 'Lowest value' }
    }

    const verdict = mark === column.better ? 'best' : 'worst'

    return { mark, verdict, markTitle: `${verdict === 'best' ? 'Best' : 'Worst'}: the ${mark === 'high' ? 'highest' : 'lowest'} value, ${column.better === HIGH ? 'higher' : 'lower'} is better` }
  })

  return out
}

// Whether the race marked a design obsolete, as a result: unavailable where the save has no flag for it.
export const obsoleteResult = (item) => (item.ObsoleteKnown ? ofRule({ rule: 'designedTech.obsolete', value: item.Obsolete ? 1 : 0 }) : unavailable({ rule: 'designedTech.obsolete', missing: ['the obsolete flag of the design'] }))
