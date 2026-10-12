import { MINERALS } from './minerals'

// The Designed page's component tables: which columns each research category shows, the figures derived from a component's stored values, and the tags a name carries. Columns are { text, value, numeric, format(item, f), note?(item, f), title?(item, f), none?(item), hint?, perHS?, compareOnly?, better?, skipZero? }: `value` is the item key the table sorts by, `format` the cell's text and `note` a second line under it, `title` a tooltip, `none` marks a cell that reads "—", `perHS` a column the table shows only when the page's per-hull-space toggle is on (Compare always has it), `compareOnly` a figure only Compare shows, `better` the side of the figure that is the better one (`'high'` or `'low'`, left out when neither is), and `skipZero` that a zero is no value, so it takes no part in best and worst. `f` is `{ count }`, the page's number formatter.

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

const ratio = (value, divisor) => (divisor > 0 ? value / divisor : 0)

const timeText = (seconds, f) => (seconds < 60 ? `${f.count(seconds, 1)} s` : seconds < 3600 ? `${f.count(seconds / 60, 1)} min` : `${f.count(seconds / 3600, 1)} h`)

const materialsTitle = (item, f) => {
  const parts = MINERALS.filter((mineral) => item[mineral.name] > 0).map((mineral) => `${mineral.name} ${f.count(item[mineral.name], 2)}`)

  return parts.length ? `Materials: ${parts.join(', ')}` : ''
}

const sizeCostCrewHTK = [
  column('Size (t)', 'Size', (item, f) => f.count(item.Size * TONS_PER_HULL_SPACE, 2), { better: LOW, hint: 'Tons. One hull space is 50 tons.' }),
  column('Cost', 'Cost', unit('Cost', 2), { better: LOW, title: materialsTitle, hint: 'Build points. Hover a cost for its materials.' }),
  plain('Crew', 'Crew', 0, { better: LOW }),
  plain('HTK', 'HTK', 0, { better: HIGH, hint: 'Hits to kill: the damage the component takes to destroy.' }),
]

const activeSensorColumns = [
  column('Range (mKm)', 'MaxSensorRange', (item, f) => f.count(item.MaxSensorRange / 1e6, 2), { better: HIGH, hint: 'Against a target of Resolution × 50 tons or larger. A smaller target is seen at a shorter range.' }),
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
    column('Max ship size (HS)', 'ComponentValue', unit('ComponentValue'), { better: HIGH, note: (item, f) => `${f.count(item.ComponentValue * TONS_PER_HULL_SPACE)} t` }),
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
    column('Capacity (t)', 'ComponentValue', (item, f) => f.count(item.ComponentValue * TONS_PER_HULL_SPACE), { better: HIGH, hint: 'The largest ship the drive jumps alone.' }),
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
    column('Missile size (MSP)', 'ComponentValue', unit('ComponentValue', 2), { note: (item, f) => `${f.count(item.ComponentValue * TONS_PER_MSP, 2)} t` }),
    perSpace('Missile size / HS', 'MeasurePerHS', 2, 'Largest missile, in MSP, per hull space of the launcher.'),
    column('Reload', 'RateOfFire', (item, f) => (item.HangarReloadOnly ? `${f.count(item.HangarReload, 1)} min` : timeText(item.RateOfFire, f)), {
      better: LOW,
      note: (item, f) => (item.HangarReloadOnly ? 'Hangar only' : item.RateOfFire >= 60 ? `${f.count(item.RateOfFire)} s` : ''),
      hint: 'A launcher marked hangar only reloads in a hangar deck.',
    }),
    ...sizeCostCrewHTK,
  ],
  4: [
    column('Size (MSP)', 'Size', unit('Size', 2), { better: LOW, note: (item, f) => `${f.count(item.Size * TONS_PER_MSP, 2)} t` }),
    plain('Speed (km/s)', 'Speed', 0, { better: HIGH }),
    column('First stage (mKm)', 'MaxRange', (item, f) => f.count(item.MaxRange / 1e6, 2), { better: HIGH, title: (item, f) => `Endurance ${timeText(item.Endurance, f)}, fuel ${f.count(item.FuelRequired)} L` }),
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
    column('ATG', 'ATG', (item, f) => `+${f.count((item.ATG - 1) * 100)}%`, { better: HIGH, none: (item) => !(item.ATG > 1), hint: 'Active terminal guidance, shown as its bonus over 1.' }),
    { text: 'Retargeting', value: 'Retargeting', numeric: false, format: () => 'Yes', none: (item) => !item.Retargeting },
    missileValue('Radiation', 'RadDamage'),
    column('Cost', 'Cost', unit('Cost', 2), { better: LOW, title: materialsTitle }),
    { text: 'Second stage', value: 'SecondStage', numeric: false, format: (item) => item.SecondStage, none: (item) => !item.SecondStageID },
  ],
  47: [
    { text: 'Breathes', value: 'GasName', numeric: false, format: (item) => item.GasName, none: (item) => !item.GasName },
    column('Gravity (G)', 'Gravity', unit('Gravity', 2), { note: (item, f) => speciesRange(item, f, 'Gravity', 'GravDev', 2) }),
    column('Temperature (°C)', 'Temperature', (item, f) => f.count(item.Temperature - KELVIN_TO_CELSIUS, 1), { note: (item, f) => speciesRange(item, f, 'Temperature', 'TempDev', 1, KELVIN_TO_CELSIUS) }),
    column('Oxygen (atm)', 'Oxygen', unit('Oxygen', 2), { note: (item, f) => speciesRange(item, f, 'Oxygen', 'OxyDev', 2) }),
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
    column('Size (MSP)', 'Size', unit('Size', 2), { better: LOW, note: (item, f) => `${f.count(item.Size * TONS_PER_MSP, 2)} t` }),
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
  4: 'Total range is the first stage plus the second stage\'s own range; a second stage that has a stage of its own is not followed further. A missile is 2.5 tons per MSP. A missile or species is not mounted on a class, so it has no Used on figures. Warhead is the strength of all a missile\'s warheads together, so warhead per MSP and per BP rate the damage a missile carries by the magazine space and the cost it takes. A ship decoy\'s warhead is a signature, not damage, and has no such figure.',
  47: 'A species lives within its ideal value plus or minus its deviation, which is the range shown under each figure. Temperatures are in °C, which is the Kelvin value minus 273. A species has no better side in any figure.',
  43: 'Shots per hull space counts the whole mount: the cannon, its turret, its fire control and its sensor.',
  41: 'A cloak rating is the share of a ship\'s signature that still shows under the cloak, so 0.07 hides 93% of it and a lower rating is better. Ship size per hull space is the cloak tech\'s efficiency; a device\'s cost grows with the square of its size.',
  3: 'A launcher\'s size is the missile size it takes times its size modifier, so missile size per hull space is one over that modifier. A box launcher (a modifier under 0.3) reloads only in a hangar deck. The largest missile a launcher takes has no better side: it is the missile I mean to fire.',
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
  item.Obsolete = !!item.Obsolete
  item.Commercial = isCommercial(item)
  item.Civilian = !!item.ShippingLineSystem

  const measure = MEASURES[item.ComponentTypeID]

  if (measure) {
    item.Measure = item.ComponentValue * (measure.scale || 1)
    item.MeasureUnit = measure.unit || ''
    item.MeasurePerHS = ratio(item.Measure, item.Size)
    item.MeasurePerCost = ratio(item.Measure, item.Cost)
  }

  if (BEAM_CATEGORY_IDS.includes(categoryId)) {
    item.TotalDamage = item.DamageOutput * item.NumberOfShots
    item.Range = item.MaxWeaponRange > 0 ? item.MaxWeaponRange : item.DamageOutput * Math.trunc(item.RangeModifier)
    item.Interval = (item.PowerRequirement === 0 ? 1 : Math.ceil(item.PowerRequirement / item.RechargeRate)) * 5
    item.DamagePerHS = ratio(item.TotalDamage, item.Size)
    item.DamagePerSecond = item.TotalDamage / item.Interval
    item.DamagePerSecondPerHS = ratio(item.DamagePerSecond, item.Size)
    item.DamagePerSecondPerCost = ratio(item.DamagePerSecond, item.Cost)
  } else if (PASSIVE_CATEGORY_IDS.includes(categoryId)) {
    SIGNATURES.forEach((signature) => {
      item[`Range${signature}`] = Math.sqrt(item.ComponentValue * signature) * 250000
    })
  } else if (categoryId === 12) {
    item.ShieldPerSecond = item.RechargeRate > 0 ? item.ComponentValue / item.RechargeRate : 0
    item.ShieldPerSecondPerHS = ratio(item.ShieldPerSecond, item.Size)
  }

  if (categoryId === 51 || categoryId === 49 || categoryId === 3) {
    item.HangarReload = item.RateOfFire / 60
    item.MFReload = item.RateOfFire / 360
  }

  return item
}

export const augmentMissile = (missile) => {
  const item = missile

  item.SDComponentID = `missile-${item.MissileID}`
  item.CategoryID = MISSILE_CATEGORY_ID
  item.MilitarySystem = 1
  item.Obsolete = !!item.Obsolete
  item.Baseline = false
  item.Commercial = false
  item.Civilian = false
  item.TotalRange = item.MaxRange + (item.SecondStageID ? item.SecondStageMaxRange || 0 : 0)
  item.SecondStage = item.SecondStageID ? `${item.NumSS} × ${item.SecondStageName}` : ''
  item.WarheadPerMSP = item.ShipDecoy ? 0 : ratio(item.WarheadStrength, item.Size)
  item.WarheadPerCost = item.ShipDecoy ? 0 : ratio(item.WarheadStrength, item.Cost)

  return item
}

export const augmentSpecies = (species) => {
  const item = species

  item.SDComponentID = `species-${item.SpeciesID}`
  item.CategoryID = SPECIES_CATEGORY_ID
  item.MilitarySystem = 1
  item.Obsolete = !!item.Obsolete
  item.Baseline = false
  item.Commercial = false
  item.Civilian = false

  return item
}

// A name's second line: the kind of component, then what marks it.
export const tagsOf = (item) => {
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

  if (item.Commercial && item.CategoryID !== MISSILE_CATEGORY_ID && item.CategoryID !== SPECIES_CATEGORY_ID) {
    tags.push('Commercial')
  }

  if (item.Civilian) {
    tags.push('Civilian')
  }

  if (PROTOTYPES[item.Prototype]) {
    tags.push(PROTOTYPES[item.Prototype])
  }

  return tags
}

// Whether a component can be mounted on a class, which a missile type or a species cannot.
export const isMountable = (item) => item.CategoryID !== MISSILE_CATEGORY_ID && item.CategoryID !== SPECIES_CATEGORY_ID
