import { MINERALS } from './minerals'

// The Designed page's component tables: which columns each research category shows, the figures derived from a component's stored values, and the tags a name carries. Columns are { text, value, numeric, format(item, f), note?(item, f), title?(item, f), none?(item), hint?, perHS? }: `value` is the item key the table sorts by, `format` the cell's text and `note` a second line under it, `title` a tooltip, `none` marks a cell that reads "—", and `perHS` a column only shown when the page's per-hull-space toggle is on. `f` is `{ count }`, the page's number formatter.

export const TONS_PER_HULL_SPACE = 50
export const TONS_PER_MSP = 2.5
const KELVIN_TO_CELSIUS = 273

// Strongest signature each passive range column is worked out against.
const SIGNATURES = [10, 100, 1000, 10000]

export const MISSILE_CATEGORY_ID = 4
export const SPECIES_CATEGORY_ID = 47

// The weapon categories whose range and damage come from the beam rules.
const BEAM_CATEGORY_IDS = [2, 27, 29, 26, 28, 35, 39]
const PASSIVE_CATEGORY_IDS = [34, 14]
const ENGINE_CATEGORY_ID = 7
const JUMP_DRIVE_TYPE_ID = 16
const COMMERCIAL_JUMP_FUNCTION = 2

const PROTOTYPES = { 1: 'Prototype', 2: 'Future prototype', 3: 'Research prototype' }

const unit = (value, decimals = 0) => (item, f) => f.count(item[value], decimals)
const column = (text, value, format, extra = {}) => ({ text, value, numeric: true, format, ...extra })
const plain = (text, value, decimals = 0, extra = {}) => column(text, value, unit(value, decimals), extra)
const positive = (value) => (item) => !(item[value] > 0)

const timeText = (seconds, f) => (seconds < 60 ? `${f.count(seconds, 1)} s` : seconds < 3600 ? `${f.count(seconds / 60, 1)} min` : `${f.count(seconds / 3600, 1)} h`)

const materialsTitle = (item, f) => {
  const parts = MINERALS.filter((mineral) => item[mineral.name] > 0).map((mineral) => `${mineral.name} ${f.count(item[mineral.name], 2)}`)

  return parts.length ? `Materials: ${parts.join(', ')}` : ''
}

const sizeCostCrewHTK = [
  column('Size (t)', 'Size', (item, f) => f.count(item.Size * TONS_PER_HULL_SPACE, 2), { hint: 'Tons. One hull space is 50 tons.' }),
  column('Cost', 'Cost', unit('Cost', 2), { title: materialsTitle, hint: 'Build points. Hover a cost for its materials.' }),
  plain('Crew', 'Crew'),
  plain('HTK', 'HTK', 0, { hint: 'Hits to kill: the damage the component takes to destroy.' }),
]

const activeSensorColumns = [
  column('Range (mKm)', 'MaxSensorRange', (item, f) => f.count(item.MaxSensorRange / 1e6, 2), { hint: 'Against a target of Resolution × 50 tons or larger. A smaller target is seen at a shorter range.' }),
  plain('Resolution', 'Resolution'),
  plain('Strength', 'ComponentValue', 2, { hint: 'The sensor strength of the whole component, its strength per hull space times its size.' }),
]

const passiveSensorColumns = [
  plain('Sensitivity', 'ComponentValue', 2),
  ...SIGNATURES.map((signature) => column(`Range vs ${signature} (mKm)`, `Range${signature}`, (item, f) => f.count(item[`Range${signature}`] / 1e6, 2), { hint: `Range against a target whose signature is ${signature}.` })),
]

const beamDamage = column('Damage', 'TotalDamage', unit('TotalDamage'), {
  note: (item, f) => (item.NumberOfShots > 1 ? `${f.count(item.DamageOutput)} × ${f.count(item.NumberOfShots)}` : ''),
  hint: 'Damage a single firing does, shown as damage × shots when a firing has several.',
})
const beamRange = column('Range (km)', 'Range', unit('Range'))
const beamTracking = plain('Tracking speed (km/s)', 'TrackingSpeed', 0, { none: positive('TrackingSpeed') })
const beamDamagePerHS = column('Damage / HS', 'DamagePerHS', unit('DamagePerHS', 2), { perHS: true, hint: 'Damage a single firing does per hull space of the weapon.' })
const beamCapacitor = [
  column('Interval', 'Interval', (item, f) => `${f.count(item.Interval)} s`, { hint: 'Time between firings: the capacitor recharge time, in steps of 5 seconds.' }),
  plain('Power', 'PowerRequirement', 2, { hint: 'Power one firing takes from the capacitor.' }),
  plain('Capacitor', 'RechargeRate', 2, { hint: 'Power the capacitor recharges each step.' }),
]

const reloadColumns = [
  column('Hangar reload', 'HangarReload', (item, f) => `${f.count(item.HangarReload, 1)} min`),
  column('MF reload', 'MFReload', (item, f) => `${f.count(item.MFReload, 1)} h`, { hint: 'Reload at a maintenance facility.' }),
]

const explosionColumns = [
  plain('Max explosion', 'MaxExplosionSize'),
  column('Explosion chance', 'ExplosionChance', (item, f) => `${f.count(item.ExplosionChance, 1)}%`),
]

const optional = (value, decimals = 2) => column('', value, (item, f) => f.count(item[value], decimals), { none: positive(value) })
const missileValue = (text, value, extra = {}) => ({ ...optional(value), text, ...extra })

const speciesRange = (item, f, value, deviation, decimals, offset = 0) => `${f.count(item[value] - item[deviation] - offset, decimals)} – ${f.count(item[value] + item[deviation] - offset, decimals)}`

const nameColumn = { text: 'Name', value: 'Name', numeric: false }

export const categoryColumnsMap = {
  13: [...activeSensorColumns, ...sizeCostCrewHTK],
  24: [...activeSensorColumns, ...sizeCostCrewHTK],
  23: [plain('Range (km)', 'ComponentValue'), plain('Tracking speed (km/s)', 'TrackingSpeed'), ...sizeCostCrewHTK],
  43: [
    column('ROF', 'ComponentValue', (item, f) => `${f.count(item.ComponentValue)} / 5 s`, { hint: 'Shots every five seconds.' }),
    plain('Tracking speed (km/s)', 'TrackingSpeed'),
    plain('ECCM', 'ECCM'),
    ...sizeCostCrewHTK,
  ],
  41: [
    column('Cloak rating', 'CloakRating', unit('CloakRating', 3)),
    column('Max ship size (HS)', 'ComponentValue', unit('ComponentValue'), { note: (item, f) => `${f.count(item.ComponentValue * TONS_PER_HULL_SPACE)} t` }),
    ...sizeCostCrewHTK,
  ],
  51: [plain('Max decoy size', 'ComponentValue'), ...reloadColumns, ...sizeCostCrewHTK],
  49: [plain('Pod size', 'ComponentValue'), ...reloadColumns, ...sizeCostCrewHTK],
  34: [...passiveSensorColumns, ...sizeCostCrewHTK],
  14: [...passiveSensorColumns, ...sizeCostCrewHTK],
  7: [
    plain('Power', 'ComponentValue', 1),
    column('Power / HS', 'EnginePowerPerHS', unit('EnginePowerPerHS', 2), { perHS: true, hint: 'Engine power per hull space.' }),
    column('Fuel per EP-hour (L)', 'FuelEfficiency', (item, f) => f.count(item.FuelEfficiency, item.FuelEfficiency >= 0.0005 ? 3 : 4), { hint: 'Litres of fuel the engine burns per engine-power-hour.' }),
    ...explosionColumns,
    ...sizeCostCrewHTK,
  ],
  39: [
    beamDamage,
    beamRange,
    beamTracking,
    column('ROF', 'NumberOfShots', (item, f) => `${f.count(item.NumberOfShots)} / 5 s`, { hint: 'Shots every five seconds.' }),
    beamDamagePerHS,
    ...sizeCostCrewHTK,
  ],
  35: [beamDamage, beamRange, ...beamCapacitor, beamDamagePerHS, ...sizeCostCrewHTK],
  22: [
    column('Capacity (t)', 'ComponentValue', (item, f) => f.count(item.ComponentValue * TONS_PER_HULL_SPACE), { hint: 'The largest ship the drive jumps alone.' }),
    plain('Squadron', 'JumpRating', 0, { hint: 'The most ships it jumps together as a squadron.' }),
    plain('Distance (k km)', 'JumpDistance'),
    ...sizeCostCrewHTK,
  ],
  2: [beamDamage, beamRange, beamTracking, ...beamCapacitor, beamDamagePerHS, ...sizeCostCrewHTK],
  42: [plain('Capacity', 'ComponentValue'), column('Capacity per HS', 'CapacityPerHS', unit('CapacityPerHS', 2)), ...sizeCostCrewHTK],
  27: [beamDamage, beamRange, beamTracking, ...beamCapacitor, beamDamagePerHS, ...sizeCostCrewHTK],
  50: sizeCostCrewHTK,
  3: [
    column('Missile size (MSP)', 'ComponentValue', unit('ComponentValue', 2), { note: (item, f) => `${f.count(item.ComponentValue * TONS_PER_MSP, 2)} t` }),
    column('Reload', 'RateOfFire', (item, f) => (item.HangarReloadOnly ? `${f.count(item.HangarReload, 1)} min` : timeText(item.RateOfFire, f)), {
      note: (item, f) => (item.HangarReloadOnly ? 'Hangar only' : item.RateOfFire >= 60 ? `${f.count(item.RateOfFire)} s` : ''),
      hint: 'A launcher marked hangar only reloads in a hangar deck.',
    }),
    ...sizeCostCrewHTK,
  ],
  4: [
    column('Size (MSP)', 'Size', unit('Size', 2), { note: (item, f) => `${f.count(item.Size * TONS_PER_MSP, 2)} t` }),
    plain('Speed (km/s)', 'Speed'),
    column('First stage (mKm)', 'MaxRange', (item, f) => f.count(item.MaxRange / 1e6, 2), { title: (item, f) => `Endurance ${timeText(item.Endurance, f)}, fuel ${f.count(item.FuelRequired)} L` }),
    column('Total range (mKm)', 'TotalRange', (item, f) => f.count(item.TotalRange / 1e6, 2), {
      title: (item, f) => (item.SecondStageID ? `First stage ${f.count(item.MaxRange / 1e6, 2)} mKm, second stage ${f.count(item.SecondStageMaxRange / 1e6, 2)} mKm, separating at ${f.count(item.SeparationRange)} km` : 'Single stage'),
    }),
    column('Warhead', 'WarheadStrength', unit('WarheadStrength', 2), { note: (item, f) => (item.MultipleWarheads > 1 ? `${f.count(item.MultipleWarheads)} warheads` : '') }),
    missileValue('Active', 'SensorStrength', { title: (item, f) => (item.SensorStrength > 0 ? `Resolution ${f.count(item.SensorResolution)}, range ${f.count(item.SensorRange / 1e6, 2)} mKm` : '') }),
    missileValue('Thermal', 'ThermalStrength'),
    missileValue('EM', 'EMStrength'),
    missileValue('Geo', 'Geostrength'),
    missileValue('Decoys', 'NumDecoys'),
    missileValue('ECCM', 'ECCM'),
    column('ATG', 'ATG', (item, f) => `+${f.count((item.ATG - 1) * 100)}%`, { none: (item) => !(item.ATG > 1), hint: 'Active terminal guidance, shown as its bonus over 1.' }),
    { text: 'Retargeting', value: 'Retargeting', numeric: false, format: () => 'Yes', none: (item) => !item.Retargeting },
    missileValue('Radiation', 'RadDamage'),
    column('Cost', 'Cost', unit('Cost', 2), { title: materialsTitle }),
    { text: 'Second stage', value: 'SecondStage', numeric: false, format: (item) => item.SecondStage, none: (item) => !item.SecondStageID },
  ],
  47: [
    { text: 'Breathes', value: 'GasName', numeric: false, format: (item) => item.GasName, none: (item) => !item.GasName },
    column('Gravity (G)', 'Gravity', unit('Gravity', 2), { note: (item, f) => speciesRange(item, f, 'Gravity', 'GravDev', 2) }),
    column('Temperature (°C)', 'Temperature', (item, f) => f.count(item.Temperature - KELVIN_TO_CELSIUS, 1), { note: (item, f) => speciesRange(item, f, 'Temperature', 'TempDev', 1, KELVIN_TO_CELSIUS) }),
    column('Oxygen (atm)', 'Oxygen', unit('Oxygen', 2), { note: (item, f) => speciesRange(item, f, 'Oxygen', 'OxyDev', 2) }),
    plain('Max atmosphere (atm)', 'PressMax', 2),
  ],
  26: [beamDamage, beamRange, ...beamCapacitor, beamDamagePerHS, ...sizeCostCrewHTK],
  29: [beamDamage, beamRange, ...beamCapacitor, beamDamagePerHS, ...sizeCostCrewHTK],
  5: [
    plain('Power', 'ComponentValue', 1),
    column('Power per HS', 'PowerPerHS', unit('PowerPerHS', 2)),
    ...explosionColumns,
    ...sizeCostCrewHTK,
  ],
  28: [beamDamage, beamRange, ...beamCapacitor, beamDamagePerHS, ...sizeCostCrewHTK],
  12: [plain('Strength', 'ComponentValue', 2), plain('Recharge time (s)', 'RechargeRate', 1), column('Per second', 'ShieldPerSecond', unit('ShieldPerSecond', 1), { hint: 'Shield strength restored each second: strength over recharge time.' }), ...sizeCostCrewHTK],
}

// Categories without an entry above show the columns every component has.
export const columnsFor = (categoryId) => [nameColumn, ...(categoryColumnsMap[categoryId] || sizeCostCrewHTK)]

// What the rules say under a category's table, besides the general line.
const CATEGORY_NOTES = {
  13: 'An active sensor sees a target of Resolution × 50 tons or larger out to its range; a smaller one only closer in.',
  24: 'A missile fire control has twice the range of an active sensor of the same strength and size. Its range is for a target of Resolution × 50 tons or larger.',
  34: 'A passive sensor sees a signature out to √(sensitivity × signature) × 250,000 km.',
  14: 'A passive sensor sees a signature out to √(sensitivity × signature) × 250,000 km.',
  7: 'Engine power is the engine tech times its size times its thrust modifier. The explosion chance is 10% per point of thrust modifier, and the largest explosion is a quarter of its power.',
  5: 'Power per hull space is the power output over the size in hull spaces.',
  42: 'Capacity per hull space is the magazine capacity over its size in hull spaces.',
  22: 'A jump drive is commercial only if it is built as a commercial drive; any other kind is commercial when it is not a military system.',
  4: 'Total range is the first stage plus the second stage\'s own range; a second stage that has a stage of its own is not followed further. A missile is 2.5 tons per MSP. A missile or species is not mounted on a class, so it has no Used on figures.',
  47: 'A species lives within its ideal value plus or minus its deviation, which is the range shown under each figure. Temperatures are in °C, which is the Kelvin value minus 273.',
}

const BEAM_NOTE = 'A beam weapon\'s range is its fixed maximum when it has one, and otherwise its damage times its range modifier. It fires every ⌈power ÷ capacitor recharge⌉ steps of 5 seconds, or every step when it needs no power. Damage per hull space counts one firing.'
const GAUSS_NOTE = 'A gauss cannon fires its shots every 5 seconds. Its range is its fixed maximum when it has one, and otherwise its damage times its range modifier. Damage per hull space counts one firing.'

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

  if (BEAM_CATEGORY_IDS.includes(categoryId)) {
    item.TotalDamage = item.DamageOutput * item.NumberOfShots
    item.Range = item.MaxWeaponRange > 0 ? item.MaxWeaponRange : item.DamageOutput * Math.trunc(item.RangeModifier)
    item.Interval = (item.PowerRequirement === 0 ? 1 : Math.ceil(item.PowerRequirement / item.RechargeRate)) * 5
    item.DamagePerHS = item.Size > 0 ? item.TotalDamage / item.Size : 0
  } else if (PASSIVE_CATEGORY_IDS.includes(categoryId)) {
    SIGNATURES.forEach((signature) => {
      item[`Range${signature}`] = Math.sqrt(item.ComponentValue * signature) * 250000
    })
  } else if (categoryId === ENGINE_CATEGORY_ID) {
    item.EnginePowerPerHS = item.Size > 0 ? item.ComponentValue / item.Size : 0
  } else if (categoryId === 12) {
    item.ShieldPerSecond = item.RechargeRate > 0 ? item.ComponentValue / item.RechargeRate : 0
  } else if (categoryId === 42) {
    item.CapacityPerHS = item.Size > 0 ? item.ComponentValue / item.Size : 0
  } else if (categoryId === 5) {
    item.PowerPerHS = item.Size > 0 ? item.ComponentValue / item.Size : 0
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
