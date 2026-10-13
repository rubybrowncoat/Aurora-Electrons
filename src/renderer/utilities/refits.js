// What refitting a ship from one class to another costs, which yards can take the work and what retooling a yard to a class costs: directional (A to B is not B to A), with every figure a result of a registered rule (utilities/provenance.js), so an input the save lacks gives an unavailable result that names it, never a cost of 0. The arithmetic is pure and takes plain class records; the loaders read them from an opened save. The Shipyards page shows them, and the class-to-yard eligibility builds on them.

import { roundHalfEven } from './design-rules'
import { MINERALS } from './minerals'
import { finishDays, shipRate, shipyardFinish, shipyardUpgradeRate } from './production'
import { combine, envelope, getRule, registerRule, ruleSupports, unavailable, valueOrNull } from './provenance'

const REFIT_VERSIONS = ['2.7.x']
const UNVERIFIED_SAVE = 'The save is not 2.7-shaped and has no version label, so the rule is not checked for its game version.'

// A refit adds 20% for the yard work, and the size change adds its own share of the added cost.
export const REFIT_OVERHEAD = 0.2
// A yard tooled for a class builds, or refits to, another within 20% of its size without retooling when the refit costs at most a fifth of the tooled class.
export const NO_RETOOL_SIZE_BAND = 0.2
export const NO_RETOOL_COST_SHARE = 1 / 5
// Retooling costs a half plus a quarter per slipway of the cheaper of the refit and the target class, times the race's shipyard operations.
export const RETOOL_BASE = 0.5
export const RETOOL_PER_SLIPWAY = 0.25
// A class's size is in hull spaces of 50 tons; a yard's capacity is in tons.
const TONS_PER_HS = 50
const COMMERCIAL_SIZE_FACTOR = 0.25

export const SHIPYARD_TYPE = Object.freeze({ NAVAL: 1, COMMERCIAL: 2, REPAIR: 3 })
// FCT_ShipyardTask.TaskTypeID of a refit and of an automatic refit; FCT_Shipyard.TaskType of a retool.
export const REFIT_TASK_TYPES = Object.freeze([2, 4])
export const RETOOL_TASK_TYPE = 7

registerRule({
  id: 'refit.cost',
  versions: REFIT_VERSIONS,
  units: 'BP',
  verification: 'confirmed',
  structure: ['FCT_ClassComponent.ClassID, ComponentID, NumComponent', 'FCT_ShipDesignComponents.Cost', 'FCT_ShipClass.Size'],
  note: 'The cost of refitting a ship from class A to class B: for each component of B, the count B has above A\'s (all of it when A lacks the component) times the component\'s cost, then times 1.2 plus the size change, the absolute size difference over A\'s size. Components B has fewer of, or lacks, earn no credit. A to B and B to A are two figures. Reproduced from the total of the stored refit tasks of 2.7-shaped saves.',
})

registerRule({
  id: 'refit.minerals',
  versions: REFIT_VERSIONS,
  units: 'units',
  verification: 'confirmed',
  structure: ['FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.Duranium, Neutronium, Corbomite, Tritanium, Boronide, Mercassium, Vendarite, Sorium, Uridium, Corundium, Gallicite'],
  note: 'The minerals of a refit: each component\'s added count, rounded to one decimal (a midpoint to the even neighbour), times its mineral cost, summed over the added components. The 20% overhead and the size surcharge add no minerals. Reproduced from the minerals of the stored refit tasks of 2.7-shaped saves.',
})

registerRule({
  id: 'refit.share',
  versions: REFIT_VERSIONS,
  units: '%',
  verification: 'confirmed',
  structure: ['refit.cost', 'FCT_ShipClass.Cost'],
  note: 'A refit\'s cost over the cost of a class, as a percentage: over the source class\'s cost (what the refit is of the ship\'s own price) or the target class\'s cost (what it is of a new build). The class named as the denominator is the one whose stored cost is used.',
})

registerRule({
  id: 'refit.noRetool',
  versions: REFIT_VERSIONS,
  units: 'yes or no',
  verification: 'estimated',
  structure: ['FCT_ShipClass.Size, Cost', 'refit.cost'],
  note: 'A yard tooled for class A builds, or refits to, class B without retooling when B is from 80% to 120% of A\'s size and the refit from A to B costs at most a fifth of A\'s cost. The test is directional and takes the tooled class A as the source. The class window\'s own marks also require the same commercial flag, which a yard\'s type replaces here. The test is the documented rule; no stored build task decides a threshold case.',
})

registerRule({
  id: 'refit.retool',
  versions: REFIT_VERSIONS,
  units: 'BP',
  verification: 'estimated',
  structure: ['FCT_Shipyard.Slipways, BuildClassID', 'FCT_Race.ShipyardOperations', 'refit.cost', 'FCT_ShipClass.Cost'],
  note: 'The cost of retooling a yard tooled for class A to class B: the lesser of the refit from A to B and B\'s own cost, times 0.5 plus 0.25 per slipway, times the race\'s shipyard operations. A yard with no class takes B at once, and so does a refit that costs nothing. The two stored retool activities found (2 and 3 slipways, operations 1 and 0.7) both sit on the target-cost side of the lesser, and the slipway and operations factor reproduces them exactly; no stored retool is priced by the refit, so that side rests on the documented rule.',
})

registerRule({
  id: 'refit.yardAccepts',
  versions: REFIT_VERSIONS,
  units: 'yes or no',
  verification: 'estimated',
  structure: ['FCT_Shipyard.SYType, Capacity', 'FCT_ShipClass.Size, Commercial, ClassShippingLineID, OtherRaceClassID'],
  note: 'A naval yard takes a class of up to its capacity in tons (50 tons to the size unit); a commercial yard takes only a commercial class within its capacity. A repair yard, or a yard of a type this rule does not know, is left unsupported. Classes of a shipping line or of another race are never taken. Retooling a yard also leaves out an obsolete class, a class with prototype components and the class the yard is already tooled for. The rule is the documented one; no stored task decides a threshold case.',
})

registerRule({
  id: 'refit.time',
  versions: REFIT_VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['refit.cost', 'production.shipRate'],
  note: 'The days a refit takes: its cost over the build rate of one slipway at a yard that takes the target class (the colony\'s shipyard build rate times a factor for the target\'s size, the size counted at a quarter for a commercial class), as the production rate rule gives it. Minerals are not simulated. The rate is not compared with a saved figure of the job.',
  assumptions: ['one slipway works on the refit', 'the minerals are in stock'],
})

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const numberOf = (value) => (isNumber(value) ? value : null)

// Whether `target` lies within the 20% size window of `source`: true or false, or null when either size is not known.
export const inBand = (source, target) => (isNumber(source.sizeHS) && isNumber(target.sizeHS) ? target.sizeHS >= source.sizeHS * (1 - NO_RETOOL_SIZE_BAND) && target.sizeHS <= source.sizeHS * (1 + NO_RETOOL_SIZE_BAND) : null)

// A figure of `rule` as a result: the rule's own verification where the save's version is shown to be covered, estimated where a confirmed rule meets a save that is not, with the standing note.
const figure = ({ rule, value, present = [], units, assumptions = [], version = null }) => {
  const registered = getRule(rule)
  const supported = ruleSupports(rule, version) === true
  const status = supported || registered.verification !== 'confirmed' ? registered.verification : 'estimated'

  return envelope({ value, status, rule, inputs: { present }, units, assumptions: supported ? assumptions : [...assumptions, UNVERIFIED_SAVE] })
}

const classLabel = (shipClass, role) => `the ${role} class${shipClass && shipClass.name ? ` ${shipClass.name}` : ''}`

// What a class is, for the arithmetic: { id, name, sizeHS, cost, commercial, obsolete, shippingLine, otherRace, prototype, counts } with `counts` the component count by component id (null where the save gives none), and null for what the save does not give.
const classOf = (row, counts, prototype) => Object.freeze({
  id: row.ShipClassID,
  name: row.ClassName,
  sizeHS: numberOf(row.Size),
  cost: numberOf(row.Cost),
  commercial: row.Commercial === 1 ? true : row.Commercial === 0 ? false : null,
  obsolete: row.Obsolete === 1 ? true : row.Obsolete === 0 ? false : null,
  shippingLine: isNumber(row.ClassShippingLineID) ? row.ClassShippingLineID > 0 : null,
  otherRace: isNumber(row.OtherRaceClassID) ? row.OtherRaceClassID > 0 : null,
  prototype,
  counts: Object.freeze(counts),
})

const CLASS_SQL = 'select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.Size, FCT_ShipClass.Cost, FCT_ShipClass.Commercial, FCT_ShipClass.Obsolete, FCT_ShipClass.ClassShippingLineID, FCT_ShipClass.OtherRaceClassID from FCT_ShipClass where FCT_ShipClass.GameID = :GameID and FCT_ShipClass.RaceID = :RaceID order by FCT_ShipClass.ClassName'

const columnsOf = async (database, table) => {
  const [rows] = await database.query(`select name from pragma_table_info('${table}')`)

  return new Set(rows.map((row) => row.name))
}

const componentSql = (columns) => `select FCT_ClassComponent.ClassID, FCT_ClassComponent.ComponentID, FCT_ClassComponent.NumComponent, FCT_ShipDesignComponents.Name, FCT_ShipDesignComponents.ComponentTypeID, FCT_ShipDesignComponents.Cost, ${columns.has('Prototype') ? 'FCT_ShipDesignComponents.Prototype' : 'null as Prototype'}, ${MINERALS.map(({ name }) => (columns.has(name) ? `FCT_ShipDesignComponents.${name}` : `null as ${name}`)).join(', ')} from FCT_ClassComponent inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ClassComponent.ClassID left join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ShipClass.GameID = :GameID and FCT_ShipClass.RaceID = :RaceID`

// The race's ship classes with the components each mounts, and the catalogue of those components: { classes, components }. `components` is by component id, each { id, name, typeId, cost, minerals }, a figure the save lacks null. A class's `counts` hold a number for each component it mounts, null for one whose count the save does not give, and no entry for one it does not mount; its `prototype` is true, false or null when a component's prototype flag is not in the save.
export const loadRefitClasses = async (database, { GameID, RaceID }) => {
  const [classRows, componentColumns] = await Promise.all([database.query(CLASS_SQL, { replacements: { GameID, RaceID } }), columnsOf(database, 'FCT_ShipDesignComponents')])
  const [partRows] = await database.query(componentSql(componentColumns), { replacements: { GameID, RaceID } })
  const counts = {}
  const prototypes = {}
  const components = {}

  partRows.forEach((row) => {
    const own = (counts[row.ClassID] = counts[row.ClassID] || {})
    const flag = isNumber(row.Prototype) ? row.Prototype > 0 : null
    const previous = row.ClassID in prototypes ? prototypes[row.ClassID] : false

    own[row.ComponentID] = isNumber(row.NumComponent) && own[row.ComponentID] !== null ? (own[row.ComponentID] || 0) + row.NumComponent : null
    prototypes[row.ClassID] = previous === true || flag === true ? true : previous === null || flag === null ? null : false

    if (!components[row.ComponentID]) {
      components[row.ComponentID] = Object.freeze({
        id: row.ComponentID,
        name: row.Name || null,
        typeId: numberOf(row.ComponentTypeID),
        cost: numberOf(row.Cost),
        minerals: Object.freeze(Object.fromEntries(MINERALS.map(({ name }) => [name, numberOf(row[name])]))),
      })
    }
  })

  return Object.freeze({
    classes: Object.freeze(classRows[0].map((row) => classOf(row, counts[row.ShipClassID] || {}, row.ShipClassID in prototypes ? prototypes[row.ShipClassID] : false))),
    components: Object.freeze(components),
  })
}

// The race's ships by class: { [ShipClassID]: count }, the ships not destroyed.
export const loadShipCounts = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query('select FCT_Ship.ShipClassID, count(*) as Ships from FCT_Ship where FCT_Ship.GameID = :GameID and FCT_Ship.RaceID = :RaceID and FCT_Ship.Destroyed = 0 group by FCT_Ship.ShipClassID', { replacements: { GameID, RaceID } })

  return Object.freeze(Object.fromEntries(rows.map((row) => [row.ShipClassID, row.Ships])))
}

// The race's shipyards as { id, populationId, colony, name, type, slipways, capacity, tooledId (the class it is tooled for, null for none, undefined when the save does not say), taskType, shipBased }.
export const loadYards = async (database, { GameID, RaceID }) => {
  const columns = await columnsOf(database, 'FCT_Shipyard')
  const [rows] = await database.query(`select FCT_Shipyard.ShipyardID, FCT_Shipyard.PopulationID, FCT_Population.PopName, FCT_Shipyard.ShipyardName, FCT_Shipyard.SYType, FCT_Shipyard.Slipways, FCT_Shipyard.Capacity, FCT_Shipyard.BuildClassID, FCT_Shipyard.TaskType, ${columns.has('ParentShipID') ? 'FCT_Shipyard.ParentShipID' : 'null as ParentShipID'} from FCT_Shipyard left join FCT_Population on FCT_Population.PopulationID = FCT_Shipyard.PopulationID where FCT_Shipyard.GameID = :GameID and FCT_Shipyard.RaceID = :RaceID order by FCT_Shipyard.ShipyardName`, { replacements: { GameID, RaceID } })

  return Object.freeze(rows.map((row) => Object.freeze({
    id: row.ShipyardID,
    populationId: row.PopulationID,
    colony: row.PopName || null,
    name: row.ShipyardName,
    type: numberOf(row.SYType),
    slipways: numberOf(row.Slipways),
    capacity: numberOf(row.Capacity),
    tooledId: isNumber(row.BuildClassID) ? (row.BuildClassID > 0 ? row.BuildClassID : null) : undefined,
    taskType: numberOf(row.TaskType),
    shipBased: isNumber(row.ParentShipID) ? row.ParentShipID > 0 : null,
  })))
}

const MINERAL_COLUMNS = MINERALS.map(({ name }) => `FCT_ShipyardTask.${name}`).join(', ')

// The running refits (refit and automatic refit tasks) of the race, one row each as stored: { ID, ShipyardTaskType, PopulationID, Name, ShipyardName, SourceClassID, TargetClassID, TotalBP, CompletedBP, RemainingProduction, Paused, CommercialModifier, ...the minerals }. `RemainingProduction`, `Paused` and `CommercialModifier` are what the Production Recap reads for any shipyard task, so a refit's time left is the same figure there; the class's size for its rate is the source class's, as the recap reads it.
export const loadRefitTasks = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(`select FCT_ShipyardTask.TaskID as ID, FCT_ShipyardTask.TaskTypeID as ShipyardTaskType, FCT_ShipyardTask.PopulationID, FCT_ShipyardTask.UnitName as Name, FCT_ShipyardTask.ShipyardID, FCT_Shipyard.ShipyardName, FCT_ShipyardTask.ClassID as SourceClassID, FCT_ShipyardTask.RefitID as TargetClassID, FCT_ShipyardTask.TotalBP, FCT_ShipyardTask.CompletedBP, FCT_ShipyardTask.TotalBP - FCT_ShipyardTask.CompletedBP as RemainingProduction, FCT_ShipyardTask.Paused, FCT_ShipClass.Size, (case when FCT_Shipyard.SYType = 1 then 1.0 when FCT_Shipyard.SYType is null then null else 0.25 end) as CommercialModifier, ${MINERAL_COLUMNS} from FCT_ShipyardTask left join FCT_Shipyard on FCT_Shipyard.ShipyardID = FCT_ShipyardTask.ShipyardID left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ShipyardTask.ClassID where FCT_ShipyardTask.GameID = :GameID and FCT_ShipyardTask.RaceID = :RaceID and FCT_ShipyardTask.TaskTypeID in (${REFIT_TASK_TYPES.join(', ')}) order by FCT_ShipyardTask.TaskID`, { replacements: { GameID, RaceID } })

  return Object.freeze(rows.map((row) => Object.freeze(row)))
}

// The yards' retool activities as the Production Recap reads a shipyard activity, plus the classes involved: { ID, PopulationID, ShipyardName, SYType, Slipways, Capacity, SourceClassID, TargetClassID, UpgradeTaskType, RequiredBP, CompletedBP, RemainingProduction, Paused }.
export const loadRetoolTasks = async (database, { GameID, RaceID }) => {
  const [rows] = await database.query(`select FCT_Shipyard.ShipyardID as ID, FCT_Shipyard.PopulationID, FCT_Shipyard.ShipyardName, FCT_Shipyard.SYType, FCT_Shipyard.Slipways, FCT_Shipyard.Capacity, FCT_Shipyard.BuildClassID as SourceClassID, FCT_Shipyard.RetoolClassID as TargetClassID, FCT_Shipyard.TaskType as UpgradeTaskType, FCT_Shipyard.RequiredBP, FCT_Shipyard.CompletedBP, FCT_Shipyard.RequiredBP - FCT_Shipyard.CompletedBP as RemainingProduction, FCT_Shipyard.PauseActivity as Paused from FCT_Shipyard where FCT_Shipyard.TaskType = ${RETOOL_TASK_TYPE} and FCT_Shipyard.GameID = :GameID and FCT_Shipyard.RaceID = :RaceID order by FCT_Shipyard.ShipyardName`, { replacements: { GameID, RaceID } })

  return Object.freeze(rows.map((row) => Object.freeze(row)))
}

// The component differences of a refit from `source` to `target`, one row for each component whose count differs or is not known: { id, name, typeId, from, to, added, removed, cost, addedBP, unknown } with `from` and `to` the counts on the two classes (null where the save gives no count, 0 where a class does not mount the component), `added` what the target has above the source (all of it for a component the source lacks), `removed` what it has fewer of, `cost` the component's cost, `addedBP` added times cost (null when a cost or a count is unknown, 0 for nothing added) and `unknown` the roles ('source', 'target') whose count is not known, which leaves `added` and `removed` null. The added components come first, the dearest first, then the removed, which earn no credit.
export const classChanges = (source, target, components) => {
  const ids = [...new Set([...Object.keys(source.counts), ...Object.keys(target.counts)])]
  const rows = []
  const countOf = (shipClass, id) => (id in shipClass.counts ? shipClass.counts[id] : 0)

  ids.forEach((id) => {
    const from = countOf(source, id)
    const to = countOf(target, id)
    const unknown = [...(from === null ? ['source'] : []), ...(to === null ? ['target'] : [])]

    if (!unknown.length && from === to) {
      return
    }

    const component = components[id] || null
    const cost = component ? component.cost : null
    const added = unknown.length ? null : to > from ? to - from : 0

    rows.push({ id: Number(id), name: component && component.name ? component.name : `component ${id}`, typeId: component ? component.typeId : null, from, to, added, removed: unknown.length ? null : from > to ? from - to : 0, cost, addedBP: unknown.length ? null : added === 0 ? 0 : cost === null ? null : added * cost, unknown })
  })

  return rows.sort((a, b) => (b.added > 0) - (a.added > 0) || (b.addedBP || 0) - (a.addedBP || 0) || a.name.localeCompare(b.name))
}

// What a changed component lacks in its counts: one entry for each class whose count of it the save does not give.
const countGaps = (change) => change.unknown.map((role) => `the count of ${change.name} on the ${role} class`)

const gaps = (source, target, changes) => {
  const missing = []

  if (!(isNumber(source.sizeHS) && source.sizeHS > 0)) {
    missing.push(`the size of ${classLabel(source, 'source')} above 0`)
  }

  if (!isNumber(target.sizeHS)) {
    missing.push(`the size of ${classLabel(target, 'target')}`)
  }

  changes.forEach((change) => (change.unknown.length ? missing.push(...countGaps(change)) : change.addedBP === null && missing.push(`the cost of ${change.name}`)))

  return missing
}

// The minerals of the added components as a result whose value is the amount of each mineral; each component's added count is rounded to one decimal, as the game does when it totals a refit's minerals.
const refitMinerals = (changes, components, version) => {
  const rule = 'refit.minerals'
  const missing = []
  const totals = Object.fromEntries(MINERALS.map(({ name }) => [name, 0]))

  changes.filter((change) => change.unknown.length).forEach((change) => missing.push(...countGaps(change)))
  changes.filter((change) => change.added > 0).forEach((change) => {
    const component = components[change.id]
    const count = roundHalfEven(change.added, 1)

    MINERALS.forEach(({ name }) => {
      const amount = component ? component.minerals[name] : null

      if (amount === null) {
        missing.push(`${name} of ${change.name}`)
      } else {
        totals[name] += count * amount
      }
    })
  })

  return missing.length ? unavailable({ rule, missing: [...new Set(missing)], units: 'units' }) : figure({ rule, value: totals, present: ['the added components\' counts and mineral costs'], units: 'units', version })
}

// A refit from `source` to `target` without its minerals: { changes, added, overhead, surcharge, total }, `changes` the component differences (`classChanges`) and every other member a result: `added` the cost of the added components, `overhead` 20% of it, `surcharge` its share for the size change and `total` the refit's cost (the sum of the three). The classes are { sizeHS, counts, name } records and `components` the catalogue of `loadRefitClasses`. `version` is the save's formula version (`loadFormulaVersion`).
export const refitTotal = (source, target, components, version = null) => {
  const rule = 'refit.cost'
  const changes = classChanges(source, target, components)
  const missing = gaps(source, target, changes)

  if (missing.length) {
    const none = unavailable({ rule, missing, units: 'BP' })

    return { changes, added: none, overhead: none, surcharge: none, total: none }
  }

  const addedBP = changes.reduce((total, change) => total + change.addedBP, 0)
  const surchargeShare = Math.abs(target.sizeHS - source.sizeHS) / source.sizeHS
  const present = ['the added components\' counts and costs', 'the two classes\' sizes']
  const make = (value) => figure({ rule, value, present, units: 'BP', version })

  return { changes, added: make(addedBP), overhead: make(addedBP * REFIT_OVERHEAD), surcharge: make(addedBP * surchargeShare), total: make(addedBP * (1 + REFIT_OVERHEAD + surchargeShare)) }
}

// A refit from `source` to `target`: `refitTotal`'s members and `minerals`, a result whose value is the amount of each mineral by name.
export const refitCost = (source, target, components, version = null) => {
  const refit = refitTotal(source, target, components, version)

  return { ...refit, minerals: refitMinerals(refit.changes, components, version) }
}

// A refit's cost as a percentage of a class's cost: `base` is { name, cost } of the class named as the denominator. Unavailable while the refit's cost or the class's cost is unknown or the cost is not above 0.
export const costShare = (total, base) => {
  const rule = 'refit.share'
  const missing = isNumber(base.cost) && base.cost > 0 ? [] : [`the cost of ${base.name} above 0`]

  if (missing.length) {
    return unavailable({ rule, missing, present: total.inputs.present, units: '%' })
  }

  return combine({ rule, parts: { 'the refit\'s cost': total }, compute: (values) => values['the refit\'s cost'] / base.cost * 100, units: '%', inputs: { present: [`the cost of ${base.name}`] } })
}

// Whether a yard tooled for `tooling` builds, or refits to, `target` without retooling, from the refit `refit` (a total result) of tooling to target: { ok (true, false or null), withinSize, affordable, limit } with `limit` the most the refit may cost (a fifth of the tooled class's cost). A test that cannot be decided from the figures given is null, and a null does not pass.
export const noRetoolCheck = (tooling, target, refit, version = null) => {
  const rule = 'refit.noRetool'
  const withinSize = inBand(tooling, target)
  const limit = isNumber(tooling.cost) ? tooling.cost * NO_RETOOL_COST_SHARE : null
  const refitValue = valueOrNull(refit)
  const affordable = limit !== null && refitValue !== null ? refitValue <= limit : null
  const failed = withinSize === false || affordable === false
  const ok = failed ? false : withinSize === true && affordable === true ? true : null
  const missing = [...(withinSize === null ? ['the sizes of the two classes'] : []), ...(limit === null ? [`the cost of ${classLabel(tooling, 'tooled')}`] : []), ...(refitValue === null && !failed ? refit.inputs.missing : [])]
  const assumptions = ruleSupports(rule, version) === true ? [] : [UNVERIFIED_SAVE]

  return { ok, withinSize, affordable, limit, result: ok === null ? unavailable({ rule, missing: [...new Set(missing)], units: 'yes or no' }) : envelope({ value: ok, status: getRule(rule).verification, rule, inputs: { present: ['the sizes and costs of the two classes', 'the refit between them'] }, units: 'yes or no', assumptions }) }
}

// What retooling a yard to `target` costs, as { kind, cost }: `kind` 'immediate' for a yard with no class (it takes the target at once) or a refit that costs nothing, 'priced' otherwise, and `cost` a result of 'refit.retool' (0 for an immediate retool). `tooling` the class the yard is tooled for, null for none; `refit` the total result of the refit from the tooling to the target; `slipways` the yard's; `operations` the race's shipyard operations.
export const retoolCost = ({ tooling, target, refit, slipways, operations, version = null }) => {
  const rule = 'refit.retool'

  if (tooling === null) {
    return { kind: 'immediate', cost: figure({ rule, value: 0, present: ['the yard has no class'], units: 'BP', version }) }
  }

  const refitValue = valueOrNull(refit)

  if (refitValue === 0) {
    return { kind: 'immediate', cost: figure({ rule, value: 0, present: ['the refit costs nothing'], units: 'BP', version }) }
  }

  const missing = [...(refitValue === null ? refit.inputs.missing : []), ...(isNumber(target.cost) ? [] : [`the cost of ${classLabel(target, 'target')}`]), ...(isNumber(slipways) ? [] : ['the yard\'s slipways']), ...(isNumber(operations) ? [] : ['the race\'s shipyard operations'])]

  if (missing.length) {
    return { kind: 'priced', cost: unavailable({ rule, missing: [...new Set(missing)], units: 'BP' }) }
  }

  const value = Math.min(refitValue, target.cost) * (RETOOL_BASE + RETOOL_PER_SLIPWAY * slipways) * operations

  return { kind: 'priced', cost: figure({ rule, value, present: ['the refit from the tooled class', 'the target\'s cost', 'the yard\'s slipways', 'the race\'s shipyard operations'], units: 'BP', version }) }
}

// Whether a yard can take `target` (to build it or to refit to it), as { status, reasons }: 'ok', 'blocked' (`reasons` says why: capacity, a commercial yard and a military class, a class of a shipping line or of another race), 'unsupported' (a repair yard or a yard of a type this rule does not know) or 'unknown' (a figure is missing: `reasons` names it). A yard's capacity is in tons and a class's size in hull spaces of 50 tons.
export const yardAccepts = (yard, target) => {
  if (yard.type !== SHIPYARD_TYPE.NAVAL && yard.type !== SHIPYARD_TYPE.COMMERCIAL) {
    return { status: yard.type === null ? 'unknown' : 'unsupported', reasons: [yard.type === null ? 'the yard\'s type' : yard.type === SHIPYARD_TYPE.REPAIR ? 'a repair yard is not covered by this rule' : `yard type ${yard.type} is not covered by this rule`], blockers: [], missing: yard.type === null ? ['the yard\'s type'] : [] }
  }

  const blockers = []
  const missing = []

  if (!isNumber(yard.capacity)) {
    missing.push('the yard\'s capacity')
  }

  if (!isNumber(target.sizeHS)) {
    missing.push(`the size of ${classLabel(target, 'target')}`)
  }

  if (isNumber(yard.capacity) && isNumber(target.sizeHS) && target.sizeHS > yard.capacity / TONS_PER_HS) {
    blockers.push(`the class (${Math.ceil(target.sizeHS * TONS_PER_HS)} t) is larger than the yard's capacity (${yard.capacity} t)`)
  }

  if (yard.type === SHIPYARD_TYPE.COMMERCIAL) {
    if (target.commercial === null) {
      missing.push(`the commercial flag of ${classLabel(target, 'target')}`)
    } else if (!target.commercial) {
      blockers.push('a commercial yard takes commercial classes only')
    }
  }

  if (target.shippingLine === true) {
    blockers.push('the class belongs to a shipping line')
  } else if (target.shippingLine === null) {
    missing.push(`whether ${classLabel(target, 'target')} belongs to a shipping line`)
  }

  if (target.otherRace === true) {
    blockers.push('the class is another race\'s')
  } else if (target.otherRace === null) {
    missing.push(`whether ${classLabel(target, 'target')} is another race's`)
  }

  return { status: blockers.length ? 'blocked' : missing.length ? 'unknown' : 'ok', reasons: [...blockers, ...missing], blockers, missing }
}

// Whether a yard can be retooled to `target`, in the same shape as `yardAccepts` (which it includes): a retool also leaves out an obsolete class, a class with prototype components and the class the yard is already tooled for. A flag the save lacks leaves the answer unknown unless a known blocker already decides it.
export const yardRetools = (yard, target) => {
  const accepted = yardAccepts(yard, target)

  if (accepted.status === 'unsupported') {
    return accepted
  }

  const blockers = [...accepted.blockers]
  const missing = [...accepted.missing]

  if (target.obsolete === true) {
    blockers.push('the class is obsolete')
  } else if (target.obsolete === null) {
    missing.push(`whether ${classLabel(target, 'target')} is obsolete`)
  }

  if (target.prototype === true) {
    blockers.push('the class has prototype components')
  } else if (target.prototype === null) {
    missing.push(`whether ${classLabel(target, 'target')} has prototype components`)
  }

  if (yard.tooledId === target.id) {
    blockers.push('the yard is already tooled for the class')
  }

  return { status: blockers.length ? 'blocked' : missing.length ? 'unknown' : 'ok', reasons: [...blockers, ...missing], blockers, missing }
}

// A yard's rate on a refit to `target`, a result of 'production.shipRate': the colony's build rate times a factor for the target's size, a quarter of the size for a commercial class. `modifiers` the colony's production modifiers row (undefined when the colony has none read).
export const refitRate = (modifiers, target) => shipRate(modifiers, { Size: target.sizeHS, CommercialModifier: target.commercial === null ? null : target.commercial ? COMMERCIAL_SIZE_FACTOR : 1 })

// The days a refit takes at `rate` (`refitRate`'s result): a result of 'refit.time', unavailable while the cost or the rate is unknown or the rate is not above 0. A refit that costs nothing takes 0 days.
export const refitTime = (total, rate) => {
  const rule = 'refit.time'

  if (!(total && total.status !== 'unavailable')) {
    return unavailable({ rule, missing: total ? total.inputs.missing : ['the refit\'s cost'] })
  }

  return finishDays({ rule, rate, remaining: total.value, remainingName: 'the refit\'s cost' }).result
}

// The days a retool takes at `yard` ({ type, capacity, slipways }): its cost (a result of 'refit.retool') over the yard's activity rate, shared among the yard's slipways, as the Production Recap times a retool in progress; a result of 'production.shipyardUpgradeFinish'. `modifiers` the colony's production modifiers row.
export const retoolTime = (modifiers, yard, cost) => {
  const shipyard = { SYType: yard.type, Capacity: yard.capacity, Slipways: yard.slipways, UpgradeTaskType: RETOOL_TASK_TYPE, Paused: 0, RemainingProduction: valueOrNull(cost) }

  return shipyardFinish(modifiers, shipyard, shipyardUpgradeRate(modifiers, shipyard)).result
}

const SAME_BP = 1e-6

// A stored refit task against the rule: { source, target, expected (the rule's total, null when unknown), stored, matches (true, false, null) } where the classes are looked up by id in `classesById`; `matches` compares the stored TotalBP with the rule within a millionth, and is null when a class is not in the save or the rule is unavailable.
export const checkRefitTask = (task, classesById, components, version = null) => {
  const source = classesById[task.SourceClassID] || null
  const target = classesById[task.TargetClassID] || null
  const refit = source && target ? refitCost(source, target, components, version) : null
  const expected = refit ? valueOrNull(refit.total) : null
  const stored = numberOf(task.TotalBP)

  return { source, target, refit, expected, stored, matches: expected === null || stored === null ? null : Math.abs(expected - stored) <= SAME_BP * Math.max(1, Math.abs(stored)) }
}

// A stored retool activity against the rule, with the same members: `expected` the rule's retool cost from the yard's tooled class to the retool class, `stored` its RequiredBP. A yard with no class has nothing to price.
export const checkRetoolTask = (task, classesById, components, operations, version = null) => {
  const source = classesById[task.SourceClassID] || null
  const target = classesById[task.TargetClassID] || null
  const refit = source && target ? refitCost(source, target, components, version) : null
  const priced = target && refit ? retoolCost({ tooling: source, target, refit: refit.total, slipways: numberOf(task.Slipways), operations, version }) : null
  const expected = priced ? valueOrNull(priced.cost) : null
  const stored = numberOf(task.RequiredBP)

  return { source, target, refit, priced, expected, stored, matches: expected === null || stored === null ? null : Math.abs(expected - stored) <= SAME_BP * Math.max(1, Math.abs(stored)) }
}
