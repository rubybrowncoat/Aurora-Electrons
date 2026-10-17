// What it costs, in build points, and how long it takes to grow a shipyard: add a slipway, add one of the fixed capacity steps, or raise the capacity continually to a target; and the labels of the work a yard does (its tasks and its upgrade activities). The prices are pure arithmetic on a yard record (utilities/refits.js `loadYards`) and the race's shipyard operations, every figure a result of a registered rule (utilities/provenance.js) so an input the save lacks gives an unavailable result that names it, never a price of 0. The time of each is the Production Recap's own: the shared rate and finish functions of utilities/production.js are called, not copied.

import { finishDays, shipRate, shipyardContinualDays, shipyardFinish, shipyardUpgradeRate } from './production'
import { isAvailable, registerRule, unavailable } from './provenance'
import { SHIPYARD_TYPE, figure } from './refits'

const VERSIONS = ['2.7.x']
const UNVERIFIED_STEPS = 'No yard activity of this step is stored in any save checked, so its price follows the pattern of the steps that are: the slipways times the same unit price times the step\'s multiple.'

// The labels of the work a yard does. A shipyard task (`FCT_ShipyardTask.TaskTypeID`) is a ship made, repaired, refitted or scrapped; an upgrade activity (`FCT_Shipyard.TaskType`) is what the yard itself is being modified with, 0 being nothing.
export const SHIPYARD_TASK_TYPES = Object.freeze({
  0: 'Construction',
  1: 'Repair',
  2: 'Refit',
  3: 'Scrap',
  4: 'Auto refit',
})

export const SHIPYARD_UPGRADE_TYPES = Object.freeze({
  1: 'Add slipway',
  2: 'Add 500 ton capacity',
  3: 'Add 1,000 ton capacity',
  4: 'Add 2,000 ton capacity',
  5: 'Add 5,000 ton capacity',
  6: 'Add 10,000 ton capacity',
  7: 'Retool',
  8: 'Continual capacity upgrade',
  9: 'Spacemaster modification',
})

export const SLIPWAY_ACTIVITY = 1
export const RETOOL_ACTIVITY = 7
export const CONTINUAL_ACTIVITY = 8

// The tech type of the race's Shipyard Operations line (a multiplier on every upgrade and retool price and time, below 1 for a better level), and the tech lines of the shipyard rates the Tech Tree links to a view of the Shipyards page: the build rate line (Improved Shipbuilding Rate) to the yards, the operations line to the growth prices.
export const OPERATIONS_TECH_TYPE = 158
export const SHIPYARD_TECH_VIEWS = Object.freeze({ 30: 'yards', [OPERATIONS_TECH_TYPE]: 'growth' })

// Build points to add one slipway to a naval yard are the capacity over 500 tons times this; a capacity step is the slipways times this times the step's multiple of 500 tons. A commercial or repair yard pays a tenth.
export const UPGRADE_UNIT_COST = 120
export const UPGRADE_UNIT_TONS = 500
export const COMMERCIAL_UPGRADE_FACTOR = 0.1

// The fixed capacity steps: the activity type, the tons added and the multiple of the unit. `pattern` marks the steps no save checked stores an activity of (500 and 2,000 tons), priced by the pattern of the others.
export const CAPACITY_STEPS = Object.freeze([
  Object.freeze({ taskType: 2, tons: 500, units: 1, pattern: true }),
  Object.freeze({ taskType: 3, tons: 1000, units: 2, pattern: false }),
  Object.freeze({ taskType: 4, tons: 2000, units: 4, pattern: true }),
  Object.freeze({ taskType: 5, tons: 5000, units: 10, pattern: false }),
  Object.freeze({ taskType: 6, tons: 10000, units: 20, pattern: false }),
])

// The most construction periods a continual upgrade is followed for: a target that would take more is not worked out, so no value typed in can keep the page stepping.
export const MAX_CONTINUAL_PERIODS = 100000
const SECONDS_PER_YEAR = 31536000

const STRUCTURE = ['FCT_Shipyard.SYType, Slipways, Capacity, TaskType, RequiredBP', 'FCT_RaceTech.TechID', 'FCT_TechSystem.TechTypeID, AdditionalInfo']

registerRule({
  id: 'shipyardGrowth.operations',
  versions: VERSIONS,
  units: '',
  verification: 'confirmed',
  structure: ['FCT_RaceTech.TechID', 'FCT_TechSystem.TechTypeID, AdditionalInfo'],
  note: 'The race\'s shipyard operations factor: the lowest multiplier among the Shipyard Operations levels (tech type 158) it holds, 1 for the normal level and less for a better one. It multiplies the build points of every yard upgrade and retool. It reproduces the stored cost of every yard activity of types 1 to 6 in the two saves checked, 64 of 64 (one yard, of a race that holds a 0.8 level, stores 192 build points against 240 at a factor of 1). A race holding no level has no factor: none is assumed.',
})

registerRule({
  id: 'shipyardGrowth.slipwayPrice',
  versions: VERSIONS,
  units: 'BP',
  verification: 'confirmed',
  structure: STRUCTURE,
  note: 'The build points to add a slipway: the yard\'s capacity over 500 tons times 120 times the race\'s shipyard operations, a tenth of it at a commercial or repair yard. It reproduces the stored cost of every add-slipway activity of the saves checked, naval and commercial.',
})

registerRule({
  id: 'shipyardGrowth.capacityStep',
  versions: VERSIONS,
  units: 'BP',
  verification: 'confirmed',
  structure: STRUCTURE,
  note: 'The build points to add 1,000, 5,000 or 10,000 tons of capacity: the yard\'s slipways times 120 times the race\'s shipyard operations times 2, 10 or 20, a tenth of it at a commercial or repair yard. It reproduces the stored cost of every such activity of the saves checked.',
})

registerRule({
  id: 'shipyardGrowth.capacityStepPattern',
  versions: VERSIONS,
  units: 'BP',
  verification: 'estimated',
  structure: STRUCTURE,
  note: 'The build points to add 500 or 2,000 tons of capacity: the same formula as the other steps, with the multiple 1 or 4. No save checked holds an activity of either step, so the price rests on the pattern of the steps that are stored.',
  assumptions: [UNVERIFIED_STEPS],
})

registerRule({
  id: 'shipyardGrowth.continualPrice',
  versions: VERSIONS,
  units: 'BP',
  verification: 'estimated',
  structure: STRUCTURE,
  note: 'The build points of a continual upgrade to a target capacity: the tons added over 500 times the slipways times 120 times the race\'s shipyard operations, a tenth of it at a commercial or repair yard, which is the price per ton of the fixed steps. The game adds capacity each construction period until the target is passed, so the last period may overshoot. A stored continual activity carries no price to compare with.',
  assumptions: ['The price per ton is the fixed steps\'; the game\'s own continual activity stores none.'],
})

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// The race's shipyard operations from the levels it holds (`loadShipyardOperations`'s rows, [] for none, null when the read is not there): a result of 'shipyardGrowth.operations', the lowest multiplier held; unavailable, naming what is missing, when none is held or a held level has no multiplier.
export const shipyardOperations = (held, version = null) => {
  const rule = 'shipyardGrowth.operations'

  if (!Array.isArray(held)) {
    return unavailable({ rule, missing: ['the race\'s held Shipyard Operations levels'], units: '' })
  } else if (!held.length) {
    return unavailable({ rule, missing: ['a Shipyard Operations level the race holds'], units: '' })
  }

  const unknown = held.filter((level) => !isNumber(level.multiplier))

  if (unknown.length) {
    return unavailable({ rule, missing: unknown.map((level) => `the multiplier of ${level.name || `Shipyard Operations level ${level.id}`}`), units: '' })
  }

  return figure({ rule, value: Math.min(...held.map((level) => level.multiplier)), present: ['the Shipyard Operations levels the race holds'], units: '', version })
}

// What a price lacks at a yard that belongs to a ship: the game does not let a ship-based yard be modified.
export const SHIP_BASED_GAP = 'a yard that belongs to no ship (a ship-based yard cannot be modified)'

// The scale an upgrade price takes from the yard's type: 1 at a naval yard, a tenth at a commercial or repair yard, null for a type the rules do not cover.
const factorOf = (type) => (type === SHIPYARD_TYPE.NAVAL ? 1 : type === SHIPYARD_TYPE.COMMERCIAL || type === SHIPYARD_TYPE.REPAIR ? COMMERCIAL_UPGRADE_FACTOR : null)

// A price of `rule`: unavailable, naming each input the yard or the operations factor lacks, else `compute(factor, operations)` as a figure of the rule. A yard that belongs to a ship cannot be modified, so it has no price, and one whose ship link is not stored names that. `uses` is which of the yard's capacity and slipways the price reads.
const priced = ({ rule, yard, operations, version, uses, compute, present, assumptions = [] }) => {
  const missing = []

  if (yard.shipBased === true) {
    missing.push(SHIP_BASED_GAP)
  } else if (yard.shipBased === null) {
    missing.push('whether the yard belongs to a ship')
  }

  if (!isNumber(yard.type)) {
    missing.push('the yard\'s type')
  } else if (factorOf(yard.type) === null) {
    missing.push(`the rules for yard type ${yard.type}`)
  }

  if (uses.includes('capacity') && !isNumber(yard.capacity)) {
    missing.push('the yard\'s capacity')
  }

  if (uses.includes('slipways') && !isNumber(yard.slipways)) {
    missing.push('the yard\'s slipways')
  }

  if (!isAvailable(operations)) {
    missing.push(...operations.inputs.missing)
  }

  if (missing.length) {
    return unavailable({ rule, missing: [...new Set(missing)], units: 'BP' })
  }

  return figure({ rule, value: compute(factorOf(yard.type), operations.value), present, units: 'BP', assumptions, version })
}

// The build points to add a slipway to `yard`: a result of 'shipyardGrowth.slipwayPrice'. `operations` is `shipyardOperations`'s result.
export const slipwayPrice = ({ yard, operations, version = null }) => priced({
  rule: 'shipyardGrowth.slipwayPrice',
  yard,
  operations,
  version,
  uses: ['capacity'],
  present: ['the yard\'s capacity and type', 'the race\'s shipyard operations'],
  compute: (factor, factorOps) => (yard.capacity / UPGRADE_UNIT_TONS) * UPGRADE_UNIT_COST * factorOps * factor,
})

// The build points to add the capacity of one of CAPACITY_STEPS to `yard`: a result of 'shipyardGrowth.capacityStep', or of 'shipyardGrowth.capacityStepPattern' for a step no save stores.
export const capacityStepPrice = ({ yard, step, operations, version = null }) => priced({
  rule: step.pattern ? 'shipyardGrowth.capacityStepPattern' : 'shipyardGrowth.capacityStep',
  yard,
  operations,
  version,
  uses: ['slipways'],
  present: ['the yard\'s slipways and type', 'the race\'s shipyard operations'],
  assumptions: step.pattern ? [UNVERIFIED_STEPS] : [],
  compute: (factor, factorOps) => yard.slipways * UPGRADE_UNIT_COST * factorOps * step.units * factor,
})

// The build points of a continual upgrade of `yard` to `target` tons: a result of 'shipyardGrowth.continualPrice', unavailable until the target is a capacity above the yard's.
export const continualPrice = ({ yard, target, operations, version = null }) => {
  const rule = 'shipyardGrowth.continualPrice'
  const price = priced({
    rule,
    yard,
    operations,
    version,
    uses: ['capacity', 'slipways'],
    present: ['the yard\'s capacity, slipways and type', 'the target capacity', 'the race\'s shipyard operations'],
    assumptions: ['The price per ton is the fixed steps\'; the game\'s own continual activity stores none.'],
    compute: (factor, factorOps) => ((isNumber(target) ? target : 0) - yard.capacity) / UPGRADE_UNIT_TONS * yard.slipways * UPGRADE_UNIT_COST * factorOps * factor,
  })

  if (!isNumber(target)) {
    return unavailable({ rule, missing: [...new Set([...(isAvailable(price) ? [] : price.inputs.missing), 'a target capacity'])], units: 'BP' })
  } else if (isAvailable(price) && !(target > yard.capacity)) {
    return unavailable({ rule, missing: ['a target capacity above the yard\'s capacity'], units: 'BP' })
  }

  return price
}

// The rows of the fixed upgrades of `yard`, the slipway first and the capacity steps after it: [{ key, taskType, label, tons (null for the slipway), price }].
export const upgradePrices = ({ yard, operations, version = null }) => [
  { key: 'slipway', taskType: SLIPWAY_ACTIVITY, label: SHIPYARD_UPGRADE_TYPES[SLIPWAY_ACTIVITY], tons: null, price: slipwayPrice({ yard, operations, version }) },
  ...CAPACITY_STEPS.map((step) => ({ key: `step-${step.tons}`, taskType: step.taskType, label: SHIPYARD_UPGRADE_TYPES[step.taskType], tons: step.tons, price: capacityStepPrice({ yard, step, operations, version }) })),
]

// The shape of a yard that the Production Recap's shipyard functions read: its type, capacity, slipways and the activity (a type, the build points left, whether it is paused and the capacity target).
const shapeOf = (yard, activity) => ({ SYType: yard.type, Capacity: yard.capacity, Slipways: yard.slipways, UpgradeTaskType: activity.taskType, Paused: activity.paused === null ? null : Number(activity.paused), RemainingProduction: activity.remaining, CapacityTarget: activity.target })

// The yard's modification rate in build points a year, a result of 'production.shipyardUpgradeRate', at its capacity now. `modifiers` the colony's production modifiers row.
export const modificationRate = (modifiers, yard) => shipyardUpgradeRate(modifiers, shapeOf(yard, { taskType: 0, paused: false, remaining: null, target: null }))

// The days to do a fixed upgrade of `taskType` for `price` build points (a result) at `yard`, as { result, idle } of 'production.shipyardUpgradeFinish': the price over the yard's modification rate, the Recap's finish for an activity.
export const upgradeTime = (modifiers, yard, taskType, price) => {
  if (!isAvailable(price)) {
    return { result: unavailable({ rule: 'production.shipyardUpgradeFinish', missing: price.inputs.missing }), idle: false }
  }

  const shape = shapeOf(yard, { taskType, paused: false, remaining: price.value, target: null })

  return shipyardFinish(modifiers, shape, shipyardUpgradeRate(modifiers, shape))
}

// The days of a continual upgrade of `yard` to `target` tons, as { result, idle } of 'production.shipyardContinual', the Recap's stepping rule and so approximate. Unavailable until the target is above the capacity, and when the target would take more than MAX_CONTINUAL_PERIODS construction periods at the yard's rate now (the rate only rises with the capacity, so this is the most periods it can take).
export const continualTime = (modifiers, yard, target, price) => {
  const rule = 'production.shipyardContinual'

  if (!isAvailable(price)) {
    return { result: unavailable({ rule, missing: price.inputs.missing }), idle: false }
  }

  const rate = modificationRate(modifiers, yard)
  const period = modifiers && isNumber(modifiers.MinConstructionPeriod) ? modifiers.MinConstructionPeriod / SECONDS_PER_YEAR : null

  if (isAvailable(rate) && period !== null && rate.value * period > 0 && price.value / (rate.value * period) > MAX_CONTINUAL_PERIODS) {
    return { result: unavailable({ rule, missing: [`a target reached within ${MAX_CONTINUAL_PERIODS.toLocaleString('en-US')} construction periods`] }), idle: false }
  }

  return shipyardContinualDays(modifiers, shapeOf(yard, { taskType: CONTINUAL_ACTIVITY, paused: false, remaining: null, target }))
}

// A shipyard task's time left as { rate, result, idle }: the Production Recap's, which is the colony's build rate for the task's class (its size, with a quarter of the weight at a yard that is not naval) over the task's remaining build points. `task` is one of a yard's `taskRows`.
export const taskFinish = (modifiers, yard, task) => {
  const rate = shipRate(modifiers, { Size: task.size, CommercialModifier: yard.type === SHIPYARD_TYPE.NAVAL ? 1 : isNumber(yard.type) ? 0.25 : null })

  return { rate, ...finishDays({ rule: 'production.shipFinish', rate, remaining: task.remaining, remainingName: 'the task\'s remaining build points', paused: task.paused }) }
}

// A yard's own activity (the upgrade or retool its `taskType` names) as { rate, result, idle }: the Recap's finish. Nothing for a yard whose activity is 0.
export const activityFinish = (modifiers, yard) => {
  const shape = shapeOf(yard, { taskType: yard.taskType, paused: yard.paused, remaining: isNumber(yard.requiredBP) && isNumber(yard.completedBP) ? yard.requiredBP - yard.completedBP : null, target: yard.capacityTarget })
  const rate = shipyardUpgradeRate(modifiers, shape)

  return { rate, ...shipyardFinish(modifiers, shape, rate) }
}

// The Shipyard Operations levels the race holds, as [{ id, name, multiplier }] (the multiplier null where the save gives none): the input of `shipyardOperations`.
export const loadShipyardOperations = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(`select FCT_TechSystem.TechSystemID, FCT_TechSystem.Name, FCT_TechSystem.AdditionalInfo from FCT_RaceTech inner join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID where FCT_RaceTech.GameID = :GameID and FCT_RaceTech.RaceID = :RaceID and FCT_TechSystem.TechTypeID = ${OPERATIONS_TECH_TYPE} order by FCT_TechSystem.AdditionalInfo, FCT_TechSystem.TechSystemID`, { replacements: { GameID, RaceID } })

  return Object.freeze(rows.map((row) => Object.freeze({ id: row.TechSystemID, name: row.Name || null, multiplier: isNumber(row.AdditionalInfo) ? row.AdditionalInfo : null })))
}
