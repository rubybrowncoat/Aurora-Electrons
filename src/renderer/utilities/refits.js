// What refitting a ship from one class to another costs, which yards can take the work and what retooling a yard to a class costs: directional (A to B is not B to A), with every figure a result of a registered rule (utilities/provenance.js), so an input the save lacks gives an unavailable result that names it, never a cost of 0. The arithmetic is pure and takes plain class records; the loaders read them from an opened save. The Shipyards page shows them, and the class-to-yard eligibility builds on them.

import { roundHalfEven } from './design-rules'
import { MINERALS } from './minerals'
import { commercialSizeFactor, finishDays, flagOf, shipRate, shipyardFinish, shipyardUpgradeRate } from './production'
import { UNVERIFIED_SAVE, combine, envelope, getRule, registerRule, ruleSupports, unavailable, valueOrNull } from './provenance'
import { SHIPYARD_TYPE } from './shipyard-types'

const REFIT_VERSIONS = ['2.7.x']
// The yard rules hold for the yard types as the game's two lines give them (the Light yard is the line's own).
const YARD_VERSIONS = ['2.7.x', '3.2.x']
// A refit adds 20% for the yard work, and the size change adds its own share of the added cost.
export const REFIT_OVERHEAD = 0.2
// The size window the Refits view lists its pairs by, so that a save with many classes shows the comparable ones: a filter on the screen, not a retool rule.
export const SIZE_BAND = 0.2
// The size band a yard with a tooled class admits a refit's source class by: the tooled class's size lies between 80% and 120% of the source's, the game's own ends of the band.
export const SOURCE_BAND_LOW = 0.8
export const SOURCE_BAND_HIGH = 1.2
// Retooling costs a half plus a quarter per slipway of the cheaper of the refit and the target class, times the race's shipyard operations.
export const RETOOL_BASE = 0.5
export const RETOOL_PER_SLIPWAY = 0.25
// A class's size is in hull spaces of 50 tons; a yard's capacity is in tons.
const TONS_PER_HS = 50

// FCT_ShipyardTask.TaskTypeID of a refit and of an automatic refit; FCT_Shipyard.TaskType of a retool.
export const REFIT_TASK_TYPES = Object.freeze([2, 4])
export const RETOOL_TASK_TYPE = 7

registerRule({
  id: 'refit.cost',
  versions: REFIT_VERSIONS,
  units: 'BP',
  verification: 'confirmed',
  structure: ['FCT_ClassComponent.ClassID, ComponentID, NumComponent', 'FCT_ShipDesignComponents.Cost', 'FCT_ShipClass.Size'],
  note: 'The cost of refitting a ship from class A to class B: for each component of B, the count B has above A\'s (all of it when A lacks the component) times the component\'s cost, then times 1.2 plus the size change, the absolute size difference over A\'s size. Components B has fewer of, or lacks, earn no credit. A to B and B to A are two figures. Reproduced from the total of the stored refit tasks of saves.',
})

registerRule({
  id: 'refit.minerals',
  versions: REFIT_VERSIONS,
  units: 'units',
  verification: 'confirmed',
  structure: ['FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.Duranium, Neutronium, Corbomite, Tritanium, Boronide, Mercassium, Vendarite, Sorium, Uridium, Corundium, Gallicite'],
  note: 'The minerals of a refit: each component\'s added count, rounded to one decimal (a midpoint to the even neighbour), times its mineral cost, summed over the added components. The 20% overhead and the size surcharge add no minerals. Reproduced from the minerals of the stored refit tasks of saves.',
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
  versions: YARD_VERSIONS,
  units: 'yes or no',
  verification: 'estimated',
  structure: ['FCT_ShipClass.Size, Cost', 'refit.cost'],
  note: 'A yard tooled for a class builds, and refits to, that class alone without a retool; every other class needs a retool, which the retool rule prices. The game\'s list of the classes a yard offers adds the class it is tooled for, then adds the alternatives its own filter passes; that filter compares each candidate with itself, so it passes nothing, and the 80% to 120% size window and the fifth-of-the-cost test it would apply decide nothing at a yard with a tooled class. A Light yard has no tooled class and none of this test: it builds, and refits to, every class it lists without retooling, whatever the class\'s size and the refit\'s cost, and a refit to it is still priced with the size-change surcharge. It lists the classes of its race that are not obsolete, not a shipping line\'s or another race\'s and within its capacity, and it can be neither retooled nor given more capacity, so a class beyond its capacity is out of its reach. No stored task decides a retool: the rule is the game\'s code.',
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
  id: 'refit.yardEligibility',
  versions: YARD_VERSIONS,
  units: '',
  verification: 'estimated',
  structure: ['FCT_Shipyard.SYType, Slipways, Capacity, BuildClassID, RetoolClassID, TaskType', 'FCT_ShipyardTask.ShipyardID', 'FCT_ShipClass.Size, Cost, Commercial, Obsolete, ClassShippingLineID, OtherRaceClassID', 'refit.noRetool'],
  note: 'Whether a yard can take work on a class, for one operation. Build and refit at a naval or commercial yard: the class a yard is tooled for is always offered, and another class is never offered without a retool, so it needs one; a class that is obsolete, a shipping line\'s, has prototype components, is larger than the yard\'s capacity (50 tons to the size unit) or, at a commercial yard, is not commercial cannot be taken at all, retool or no retool. A yard with no tooled class takes the class it is tooled for at once and free. A refit also needs its source class within the capacity and, at a commercial yard, commercial, and costs something; at a yard with a tooled class a source class is listed only when the class tooled at the time of the refit has a size between 80% and 120% of the source\'s, the class the yard is tooled for now or, when a retool comes first, the target it is retooled for, so a source the target\'s band leaves out is refused after the retool too. A Light yard asks no band. A Light yard has no tooling: it offers every class of its race that is not obsolete, not a shipping line\'s or another race\'s, without prototype components and within its capacity (1,000 tons as built, never changed), asks nothing of a refit\'s source class but its capacity, and has neither retool nor capacity upgrade, so a class beyond its capacity cannot be taken at all. Repair: a ship of the class within the capacity at a naval, Light or repair yard, or a commercial class at a commercial yard, with no tooling. Every operation needs a free slipway (the yard\'s slipways less its tasks). Only the naval, commercial, repair and Light yard types are covered: another type stays unsupported. No stored task decides a retool: the alternative filters of the game\'s class list compare a candidate with itself, so only the tooled class is offered without one.',
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

// Whether `target` lies within the 20% size window of `source`, the window the Refits view filters its matrix of pairs by: true or false, or null when either size is not known.
export const inBand = (source, target) => (isNumber(source.sizeHS) && isNumber(target.sizeHS) ? target.sizeHS >= source.sizeHS * (1 - SIZE_BAND) && target.sizeHS <= source.sizeHS * (1 + SIZE_BAND) : null)

// Whether a yard tooled for `tooled` lists `source` as the class a refit is from: the tooled class's size lies between 80% and 120% of the source's (Shipyard.cs:521 for the commercial branch and :524 for the other, the candidate class's own size against the class the yard is tooled for), so a source far smaller or larger than the tooled class is left out; true or false, or null when either size is not known.
export const sourceWithinBand = (tooled, source) => (isNumber(tooled.sizeHS) && isNumber(source.sizeHS) ? tooled.sizeHS >= source.sizeHS * SOURCE_BAND_LOW && tooled.sizeHS <= source.sizeHS * SOURCE_BAND_HIGH : null)

// A figure of `rule` as a result: the rule's own verification where the save's version is shown to be covered, estimated where a confirmed rule meets a save that is not, with the standing note.
export const figure = ({ rule, value, present = [], units, assumptions = [], version = null }) => {
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

const taskSql = (columns) => `select FCT_ShipyardTask.TaskID, FCT_ShipyardTask.ShipyardID, FCT_ShipyardTask.TaskTypeID, FCT_ShipyardTask.ClassID, FCT_ShipyardTask.RefitID, FCT_ShipyardTask.UnitName, FCT_ShipyardTask.TotalBP, FCT_ShipyardTask.CompletedBP, FCT_ShipyardTask.Paused, ${columns.has('NumShips') ? 'FCT_ShipyardTask.NumShips' : 'null as NumShips'}, TaskClass.ClassName, TaskClass.Size, TaskClass.Commercial, TargetClass.Size as TargetSize, TargetClass.Commercial as TargetCommercial from FCT_ShipyardTask left join FCT_ShipClass TaskClass on TaskClass.ShipClassID = FCT_ShipyardTask.ClassID left join FCT_ShipClass TargetClass on TargetClass.ShipClassID = FCT_ShipyardTask.RefitID where FCT_ShipyardTask.GameID = :GameID and FCT_ShipyardTask.RaceID = :RaceID order by FCT_ShipyardTask.TaskID`

const taskOf = (row) => Object.freeze({
  id: row.TaskID,
  taskType: numberOf(row.TaskTypeID),
  classId: numberOf(row.ClassID),
  className: row.ClassName || null,
  refitId: isNumber(row.RefitID) && row.RefitID > 0 ? row.RefitID : null,
  name: row.UnitName || null,
  totalBP: numberOf(row.TotalBP),
  completedBP: numberOf(row.CompletedBP),
  remaining: isNumber(row.TotalBP) && isNumber(row.CompletedBP) ? row.TotalBP - row.CompletedBP : null,
  hulls: numberOf(row.NumShips),
  paused: flagOf(row.Paused),
  size: numberOf(row.Size),
  commercial: flagOf(row.Commercial),
  targetSize: numberOf(row.TargetSize),
  targetCommercial: flagOf(row.TargetCommercial),
})

// The race's shipyards as { id, populationId, colony, name, type, slipways, capacity, tooledId (the class it is tooled for, null for none, undefined when the save does not say), retoolId (the class a retool in progress is for, null for none), taskType (what the yard is modifying, 0 for nothing), requiredBP, completedBP, paused (true, false or null) and capacityTarget (the yard's own activity, null where the save has no figure), tasks (the tasks at the yard, a real 0 for none, null when the save has no task table), taskRows (those tasks as the Production Recap reads one: { id, taskType, classId, className, refitId, name, totalBP (the current hull's), completedBP, remaining (the current hull's balance), hulls (the ships the task still builds, the current one and the later ones; null where the save does not say), paused, size and commercial (the class the task builds), targetSize and targetCommercial (the class a refit is to; null for a task that is not a refit) }, a real [] for none and null when the save has no task table), shipBased }.
export const loadYards = async (database, { GameID, RaceID }) => {
  const [columns, taskColumns] = await Promise.all([columnsOf(database, 'FCT_Shipyard'), columnsOf(database, 'FCT_ShipyardTask')])
  const hasTasks = taskColumns.has('ShipyardID')
  const tasks = hasTasks ? '(select count(*) from FCT_ShipyardTask where FCT_ShipyardTask.ShipyardID = FCT_Shipyard.ShipyardID)' : 'null'
  const own = (name, alias = name) => (columns.has(name) ? `FCT_Shipyard.${name} as ${alias}` : `null as ${alias}`)
  const [rows] = await database.query(`select FCT_Shipyard.ShipyardID, FCT_Shipyard.PopulationID, FCT_Population.PopName, FCT_Shipyard.ShipyardName, FCT_Shipyard.SYType, FCT_Shipyard.Slipways, FCT_Shipyard.Capacity, FCT_Shipyard.BuildClassID, ${own('RetoolClassID')}, FCT_Shipyard.TaskType, ${own('RequiredBP')}, ${own('CompletedBP')}, ${own('PauseActivity')}, ${own('CapacityTarget')}, ${tasks} as Tasks, ${own('ParentShipID')} from FCT_Shipyard left join FCT_Population on FCT_Population.PopulationID = FCT_Shipyard.PopulationID where FCT_Shipyard.GameID = :GameID and FCT_Shipyard.RaceID = :RaceID order by FCT_Shipyard.ShipyardName`, { replacements: { GameID, RaceID } })
  const taskRows = {}

  if (hasTasks) {
    const [stored] = await database.query(taskSql(taskColumns), { replacements: { GameID, RaceID } })

    stored.forEach((row) => (taskRows[row.ShipyardID] = taskRows[row.ShipyardID] || []).push(taskOf(row)))
  }

  return Object.freeze(rows.map((row) => Object.freeze({
    id: row.ShipyardID,
    populationId: row.PopulationID,
    colony: row.PopName || null,
    name: row.ShipyardName,
    type: numberOf(row.SYType),
    slipways: numberOf(row.Slipways),
    capacity: numberOf(row.Capacity),
    tooledId: isNumber(row.BuildClassID) ? (row.BuildClassID > 0 ? row.BuildClassID : null) : undefined,
    retoolId: isNumber(row.RetoolClassID) && row.RetoolClassID > 0 ? row.RetoolClassID : null,
    taskType: numberOf(row.TaskType),
    requiredBP: numberOf(row.RequiredBP),
    completedBP: numberOf(row.CompletedBP),
    paused: flagOf(row.PauseActivity),
    capacityTarget: numberOf(row.CapacityTarget),
    tasks: numberOf(row.Tasks),
    taskRows: hasTasks ? Object.freeze(taskRows[row.ShipyardID] || []) : null,
    shipBased: isNumber(row.ParentShipID) ? row.ParentShipID > 0 : null,
  })))
}

const MINERAL_COLUMNS = MINERALS.map(({ name }) => `FCT_ShipyardTask.${name}`).join(', ')

// The running refits (refit and automatic refit tasks) of the race, one row each as stored: { ID, ShipyardTaskType, PopulationID, Name, ShipyardName, SourceClassID, TargetClassID, TotalBP (the current hull's), CompletedBP, RemainingProduction (the current hull's balance), Hulls (the ships the task still builds, the current one and the later ones; null where the save does not say), Paused, Size, CommercialModifier, ...the minerals }. `RemainingProduction`, `Hulls`, `Paused`, `Size` and `CommercialModifier` are what the Production Recap reads for any shipyard task, so a refit's time left is the same figure there; `Size` and `CommercialModifier` are the target class's, its size and the factor of its `Commercial` flag, as the game dates a refit task (Population.cs `RefreshShipyardTasksListView`: `RecalculateBuildRateForClass(item.gclass22_1)`, the class a refit is to).
export const loadRefitTasks = async (database, { GameID, RaceID }) => {
  const taskColumns = await columnsOf(database, 'FCT_ShipyardTask')
  const hulls = taskColumns.has('NumShips') ? 'FCT_ShipyardTask.NumShips' : 'null'
  const [rows] = await database.query(`select FCT_ShipyardTask.TaskID as ID, FCT_ShipyardTask.TaskTypeID as ShipyardTaskType, FCT_ShipyardTask.PopulationID, FCT_ShipyardTask.UnitName as Name, FCT_ShipyardTask.ShipyardID, FCT_Shipyard.ShipyardName, FCT_ShipyardTask.ClassID as SourceClassID, FCT_ShipyardTask.RefitID as TargetClassID, FCT_ShipyardTask.TotalBP, FCT_ShipyardTask.CompletedBP, FCT_ShipyardTask.TotalBP - FCT_ShipyardTask.CompletedBP as RemainingProduction, ${hulls} as Hulls, FCT_ShipyardTask.Paused, TargetClass.Size, (case when TargetClass.Commercial = 0 then 1.0 when TargetClass.Commercial is null then null else 0.25 end) as CommercialModifier, ${MINERAL_COLUMNS} from FCT_ShipyardTask left join FCT_Shipyard on FCT_Shipyard.ShipyardID = FCT_ShipyardTask.ShipyardID left join FCT_ShipClass TargetClass on TargetClass.ShipClassID = FCT_ShipyardTask.RefitID where FCT_ShipyardTask.GameID = :GameID and FCT_ShipyardTask.RaceID = :RaceID and FCT_ShipyardTask.TaskTypeID in (${REFIT_TASK_TYPES.join(', ')}) order by FCT_ShipyardTask.TaskID`, { replacements: { GameID, RaceID } })

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

// Whether a yard tooled for `tooling` builds, or refits to, `target` without retooling: true only for a class with the tooled class's own id, false for every other class (a retool is what admits it), null when the save does not give an id for one of them. The game's yard adds the class it is tooled for to its list (`Shipyard.cs:466`) and then the alternatives its filter passes; that filter compares each candidate with itself (`gclass22_0 != gclass22_0`, Shipyard.cs:468 and :471), so it passes nothing, and the 80% to 120% window with the at-most-a-fifth cost share at Shipyard.cs:476 (`withinSize`, `affordable` and `limit`, always null here) decides nothing. The 2.7.1 line, Shipyard.cs:454, reads the same. `version` is the save's formula version (`loadFormulaVersion`).
export const noRetoolCheck = (tooling, target, version = null) => {
  const rule = 'refit.noRetool'
  const known = tooling.id !== null && tooling.id !== undefined && target.id !== null && target.id !== undefined
  const ok = known ? tooling.id === target.id : null
  const assumptions = ruleSupports(rule, version) === true ? [] : [UNVERIFIED_SAVE]

  return { ok, withinSize: null, affordable: null, limit: null, result: ok === null ? unavailable({ rule, missing: ['the ids of the two classes'], units: 'yes or no' }) : envelope({ value: ok, status: getRule(rule).verification, rule, inputs: { present: ['the class the yard is tooled for'] }, units: 'yes or no', assumptions }) }
}

// The no-retool verdict of a class a Light yard lists, as `noRetoolCheck`'s members: true, with no size window and no cost test (`withinSize`, `affordable` and `limit` are null: a Light yard asks neither, Shipyard.cs:485-488, which lists every class of the race within the yard's capacity). The caller has established that the class passes the yard's list (its race's, not obsolete, not a shipping line's or another race's, within the capacity); a refit to it is still priced by `refitTotal`, size-change surcharge and all.
export const listedNoRetool = (version = null) => {
  const rule = 'refit.noRetool'
  const assumptions = ruleSupports(rule, version) === true ? [] : [UNVERIFIED_SAVE]

  return { ok: true, withinSize: null, affordable: null, limit: null, result: envelope({ value: true, status: getRule(rule).verification, rule, inputs: { present: ['the yard lists the class'] }, units: 'yes or no', assumptions }) }
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

export const YARD_OPERATIONS = Object.freeze(['build', 'refit', 'repair'])
// What a yard can do for a class: take it now, take it once a slipway is free, take it after a retool, not take it, be of a type the rules do not cover, or not be decidable from the save.
export const YARD_STATES = Object.freeze(['capable', 'busy', 'retool', 'ineligible', 'unsupported', 'unknown'])

// The class a yard is tooled for: the class record, null for none, undefined when the save does not say or the class is not in `classesById`.
export const tooledClassOf = (yard, classesById) => (yard.tooledId === null ? null : yard.tooledId === undefined ? undefined : classesById[yard.tooledId] || undefined)

const flagged = (blockers, gaps, value, blocker, gap) => {
  if (value === true) {
    blockers.push(blocker)
  } else if (value === null) {
    gaps.push(gap)
  }
}

const refitOf = (from, to, { components, version, cache }) => {
  const key = `${from.id}>${to.id}`

  if (cache && cache.has(key)) {
    return cache.get(key)
  }

  const total = refitTotal(from, to, components, version).total

  if (cache) {
    cache.set(key, total)
  }

  return total
}

// Whether `yard` can do `operation` ('build', 'refit' or 'repair') on `target`, with `source` the class being refitted from (only a refit has one): { operation, state (one of YARD_STATES), reasons (every blocker, every gap and the facts that decided it, as sentences), blockers, missing, notes (what does not change the state), slipways { total, tasks, free }, tooling, result }. `tooling` is { kind ('tooled', 'retool', 'unassigned', 'listed' (a Light yard's, which needs no tooling) or 'unknown'), tooled (the class record, null for none), refit (the total result of tooled to target), check (the no-retool check), failed (why a retool is needed) }, null for a repair or a class that cannot be taken. `result` is a result of 'refit.yardEligibility' whose value is the state, unavailable for 'unknown' (naming the gaps) and for 'unsupported'. A figure the save lacks never reads as a pass: it leaves the state unknown unless a known blocker decides it. A refit's source class is judged by its own selector: the yard's capacity, the class's flags and, at a yard with a tooled class, the size band of the tooled class (`sourceWithinBand`), which a Light yard does not ask. `context` is { classesById, components, version, cache (an optional Map for the refits between classes) }.
export const yardEligibility = (yard, target, operation, context, source = null) => {
  if (!YARD_OPERATIONS.includes(operation)) {
    throw new Error(`Unknown yard operation ${operation}`)
  }

  const rule = 'refit.yardEligibility'
  const { classesById = {}, version = null } = context
  const total = numberOf(yard.slipways)
  const tasks = numberOf(yard.tasks)
  const slipways = { total, tasks, free: total !== null && tasks !== null ? total - tasks : null }
  const blockers = []
  const missing = []
  const info = []
  const notes = []
  let tooling = null
  let state = 'capable'

  const finish = (final) => Object.freeze({
    operation,
    state: final,
    reasons: Object.freeze([...blockers, ...[...new Set(missing)].map((item) => `Not known: ${item}`), ...(final === 'unknown' || final === 'ineligible' ? [] : info)]),
    blockers: Object.freeze(blockers),
    missing: Object.freeze([...new Set(missing)]),
    notes: Object.freeze(notes),
    slipways: Object.freeze(slipways),
    tooling: tooling && Object.freeze(tooling),
    result: final === 'unknown' ? unavailable({ rule, missing: [...new Set(missing)], units: '' }) : final === 'unsupported' ? unavailable({ rule, missing: [`the rules for yard type ${yard.type}`], units: '' }) : figure({ rule, value: final, present: ['the yard\'s type, slipways, tasks and capacity', 'the class\'s size and flags'], units: '', version }),
  })

  if (typeof version === 'string' && ruleSupports(rule, version) === false) {
    missing.push(`the rules for game version ${version}`)

    return finish('unknown')
  }

  if (yard.type !== null && !Object.values(SHIPYARD_TYPE).includes(yard.type)) {
    info.push(`Yard type ${yard.type} is not covered by the rules`)

    return finish('unsupported')
  }

  if (yard.type === SHIPYARD_TYPE.REPAIR && operation !== 'repair') {
    blockers.push('A repair yard neither builds nor refits ships')

    return finish('ineligible')
  }

  const whatOf = (role) => (role === 'source' ? 'The source class' : 'The class')

  const sizeAndType = (shipClass, role, into, gaps) => {
    if (!isNumber(yard.capacity)) {
      gaps.push('the yard\'s capacity')
    }

    if (!isNumber(shipClass.sizeHS)) {
      gaps.push(`the size of ${classLabel(shipClass, role)}`)
    }

    if (isNumber(yard.capacity) && isNumber(shipClass.sizeHS) && shipClass.sizeHS > yard.capacity / TONS_PER_HS) {
      into.push(`${whatOf(role)} (${Math.ceil(shipClass.sizeHS * TONS_PER_HS)} t) is larger than the yard's capacity (${Math.round(yard.capacity)} t)`)
    }

    if (yard.type === SHIPYARD_TYPE.COMMERCIAL) {
      if (shipClass.commercial === null) {
        gaps.push(`the commercial flag of ${classLabel(shipClass, role)}`)
      } else if (shipClass.commercial === false) {
        into.push(`${whatOf(role)} is not commercial and a commercial yard takes commercial classes only`)
      }
    }
  }

  if (yard.type === null) {
    missing.push('the yard\'s type')
  }

  if (operation === 'repair') {
    sizeAndType(target, 'target', blockers, missing)
  } else {
    const label = classLabel(target, 'target')
    const hard = []
    const gaps = []

    flagged(blockers, missing, target.prototype, 'The class has prototype components', `whether ${label} has prototype components`)
    sizeAndType(target, 'target', hard, gaps)
    flagged(hard, gaps, target.obsolete, 'The class is obsolete', `whether ${label} is obsolete`)
    flagged(hard, gaps, target.shippingLine, 'The class belongs to a shipping line', `whether ${label} belongs to a shipping line`)

    if (yard.taskType === RETOOL_TASK_TYPE) {
      const retooling = classesById[yard.retoolId]

      notes.push(`The yard is being retooled${retooling ? ` for ${retooling.name}` : ''}; it keeps its tooled class until that completes`)
    }

    const light = yard.type === SHIPYARD_TYPE.LIGHT

    // A Light yard has no tooling and lists the classes it can take (Shipyard.cs:485-488): every class of the race within its capacity, less those whose stored flags exclude them.
    if (light) {
      const overCapacity = isNumber(yard.capacity) && isNumber(target.sizeHS) && target.sizeHS > yard.capacity / TONS_PER_HS

      flagged(hard, gaps, target.otherRace, 'The class is another race\'s, which a light yard does not list', `whether ${label} is another race's`)
      blockers.push(...hard)
      missing.push(...gaps)

      if (overCapacity) {
        blockers.push('A light yard can be neither retooled nor given more capacity')
      }

      if (!blockers.length && !gaps.length) {
        tooling = { kind: 'listed', tooled: null, refit: null, check: listedNoRetool(version), failed: [] }
        info.push('A light yard lists the class without tooling, of any size within its capacity')
      }
    } else if (yard.tooledId === target.id) {
      tooling = { kind: 'tooled', tooled: target, refit: null, check: null, failed: [] }
      info.push('The yard is tooled for the class')

      if (hard.length) {
        notes.push(`The class is offered because the yard is tooled for it, whatever its other flags: ${hard.map((reason) => reason.charAt(0).toLowerCase() + reason.slice(1)).join('; ')}`)
      }
    } else {
      blockers.push(...hard)
      missing.push(...gaps)

      if (!blockers.length && !gaps.length && yard.tooledId === null) {
        state = 'retool'
        tooling = { kind: 'unassigned', tooled: null, refit: null, check: null, failed: [] }
        info.push('The yard has no tooled class: assigning one is free and immediate')
      } else if (!blockers.length && !gaps.length) {
        const tooled = tooledClassOf(yard, classesById)

        if (tooled === undefined) {
          missing.push('the class the yard is tooled for')
          tooling = { kind: 'unknown', tooled: undefined, refit: null, check: null, failed: [] }
        } else {
          const refit = refitOf(tooled, target, context)
          const check = noRetoolCheck(tooled, target, version)
          const failed = [`The yard is tooled for ${tooled.name}: only the class it is tooled for needs no retool`]

          if (target.otherRace === true) {
            failed.push('The class is another race\'s')
          } else if (target.otherRace === null) {
            missing.push(`whether ${label} is another race's`)
          }

          state = 'retool'
          info.push(...failed)
          tooling = { kind: 'retool', tooled, refit, check, failed }
        }
      }
    }

    if (operation === 'refit' && source) {
      const own = classLabel(source, 'source')

      if (source.id === target.id) {
        blockers.push('A refit needs a source class other than its target')
      }

      sizeAndType(source, 'source', blockers, missing)
      flagged(blockers, missing, source.shippingLine, 'The source class belongs to a shipping line', `whether ${own} belongs to a shipping line`)

      // A refit's source class is its own selector (Population.cs:6589-6592), not the target list: the size of the class tooled when the refit is made must lie between 80% and 120% of the source's (Shipyard.cs:521 and :524). At the yard's current tooling that is the class the yard is tooled for; a yard that needs a retool first, or has no class and is given one, is tooled for the target by then, so the band is asked of the target instead, and a source outside it is refused after the retool too. A Light yard passes no tooled class and so asks no band (Economics.cs:2568 and :2572).
      if (yard.type !== null && yard.type !== SHIPYARD_TYPE.LIGHT) {
        const afterRetool = yard.tooledId !== target.id
        const tooled = afterRetool ? target : tooledClassOf(yard, classesById)
        const role = afterRetool ? 'target' : 'tooled'

        if (tooled === undefined) {
          missing.push('the class the yard is tooled for')
        } else {
          const within = sourceWithinBand(tooled, source)

          if (within === null) {
            missing.push(afterRetool ? `the size of ${own} or of the class the yard would be tooled for after the retool` : `the size of ${own} or of the class the yard is tooled for`)
          } else if (within) {
            info.push(afterRetool ? `The source class is within the size band of ${classLabel(tooled, role)}, the class the yard would be tooled for after the retool` : `The source class is within the size band of ${classLabel(tooled, role)}`)
          } else {
            blockers.push(afterRetool ? `The source class (${Math.ceil(source.sizeHS * TONS_PER_HS)} t) is outside the size band of ${classLabel(tooled, role)} (${Math.ceil(tooled.sizeHS * TONS_PER_HS)} t), the class the yard would be tooled for after the retool, whose size must lie between 80% and 120% of the source's` : `The source class (${Math.ceil(source.sizeHS * TONS_PER_HS)} t) is outside the size band of ${classLabel(tooled, role)} (${Math.ceil(tooled.sizeHS * TONS_PER_HS)} t), whose size must lie between 80% and 120% of the source's`)
          }
        }
      }

      if (source.id !== target.id) {
        const cost = refitOf(source, target, context)

        if (valueOrNull(cost) === 0) {
          blockers.push('A refit that costs nothing is not created')
        } else if (valueOrNull(cost) === null) {
          missing.push(...cost.inputs.missing)
        }
      }

      if (source.commercial !== null && target.commercial !== null && source.commercial !== target.commercial) {
        notes.push('The two classes differ in their commercial flag, which blocks no refit by itself: a commercial yard takes a commercial target alone, whatever the source')
      }
    }
  }

  let final = blockers.length ? 'ineligible' : missing.length ? 'unknown' : state

  if (final === 'capable') {
    if (slipways.free === null) {
      missing.push(...(total === null ? ['the yard\'s slipways'] : []), ...(tasks === null ? ['the tasks at the yard'] : []))
      final = 'unknown'
    } else if (slipways.free <= 0) {
      final = 'busy'
      info.push(`All ${total} slipway${total === 1 ? ' is' : 's are'} working`)
    }
  } else if (final === 'retool' && slipways.free !== null && slipways.free <= 0) {
    notes.push(`All ${total} slipway${total === 1 ? ' is' : 's are'} working`)
  }

  return finish(final)
}

// A yard's rate on a refit to `target`, a result of 'production.shipRate': the colony's build rate times a factor for the target's size, the size counted at a quarter for a commercial class (`commercialSizeFactor` of the class's `Commercial` flag). `modifiers` the colony's production modifiers row (undefined when the colony has none read).
export const refitRate = (modifiers, target) => shipRate(modifiers, { Size: target.sizeHS, CommercialModifier: commercialSizeFactor(target.commercial) })

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
