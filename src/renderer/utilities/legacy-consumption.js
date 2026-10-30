// The minerals a race's fuel refineries, maintenance facilities and shipyards use, worked out from the save's installations, shipyard tasks and race rates, for a save that has no mineral ledger to observe them in (the Mineral Outlook's fallback). Every figure is a provenance result (utilities/provenance.js): an input the save does not hold makes the figure unavailable and names it, never 0. A save with a ledger observes these uses, so the page never adds this model to it.

import { LITRES_PER_TON, MSP_MINERALS, mspProduction, refineryYield } from './logistics'
import { MINERALS } from './minerals'
import { shipRate, shipyardUpgradeRate } from './production'
import { combine, envelope, isAvailable, ofRule, registerRule, sumResults, unavailable, weakestStatus } from './provenance'

const VERSIONS = ['2.7.x']

// The uses a ledger-less save can switch on and off, in the order the page lists them. `groups` are the ledger's flow groups (FLOW_GROUPS of minerals.js) that the category stands for when a ledger observes it, and `rule` the rule of its modelled results.
export const CATEGORIES = Object.freeze([
  Object.freeze({ key: 'industry', label: 'Industry queue', groups: Object.freeze(['construction', 'ordnance']), rule: 'mineral.queueDemand' }),
  Object.freeze({ key: 'fuel', label: 'Fuel refining', groups: Object.freeze(['fuel']), rule: 'legacy.fuelUse' }),
  Object.freeze({ key: 'maintenance', label: 'Maintenance supplies', groups: Object.freeze(['maintenance']), rule: 'legacy.maintenanceUse' }),
  Object.freeze({ key: 'shipbuilding', label: 'Shipbuilding', groups: Object.freeze(['shipbuilding']), rule: 'legacy.shipbuildingUse' }),
])

export const CATEGORY_KEYS = Object.freeze(CATEGORIES.map((category) => category.key))

// A use the page lists but has no rule for: observed when a ledger holds it, otherwise missing for this reason, and never switched.
export const UNMODELLED = Object.freeze({ key: 'ground', label: 'Ground unit training', groups: Object.freeze(['ground']), reason: 'no rule for the minerals of ground unit training is checked against a saved figure, so without a ledger they are not counted' })

registerRule({
  id: 'legacy.fuelUse',
  versions: VERSIONS,
  units: 't/yr',
  verification: 'confirmed',
  structure: ['FCT_Population.FuelProdStatus, Sorium', 'FCT_Race.FuelProduction', 'FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.RefineryProductionValue', 'the colony\'s production modifier'],
  note: 'The Sorium a year the race\'s refineries take: the whole refineries of a colony with fuel production on and at least 1 t of Sorium, times the racial fuel rate and the colony\'s production modifier, at 2,000 litres of fuel a tonne. At the last production tick of three saves it matched the Sorium the mineral ledger logs for fuel refining on every colony with refineries, those with production off or no Sorium giving 0 in both. The cut of the refineries to a whole number is the game\'s own and no saved colony has a fraction, so a result that rests on it is an estimate. On a campaign of 149 saves five days apart the rule, read from the earlier save of each pair, matched the Sorium an NPR\'s deposits lost less the rise of its stock to within 0.02% in every pair tried.',
  assumptions: ['the colony keeps the Sorium its refineries use for the year'],
})

registerRule({
  id: 'legacy.maintenanceUse',
  versions: VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_Population.MaintProdStatus, Duranium, Uridium, Gallicite, SystemBodyID', 'FCT_MineralDeposit.MaterialID, Amount', 'FCT_Race.MSPProduction', 'FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.MaintenanceValue, MiningProductionValue', 'the colony\'s production modifier'],
  note: 'The Duranium, Uridium and Gallicite a year the race\'s maintenance facilities take: the whole facilities of the colonies that draw on one stock (an NPR\'s colonies share its capital\'s), with maintenance production on, times the racial rate, 4 MSP a build point and the colony\'s production modifier, at 0.1, 0.05 and 0.1 t of those minerals an MSP, and no more MSP in all than the scarcest of the three minerals in that stock allows, spent once. A stock that covers the facilities\' output for the year is enough whatever is mined. A stock that does not is all there is of that mineral, unless a colony of the pool has a mine on a body whose deposit of it still holds some (or whose amount or mine count the save does not give): what the mine adds is not quantified, so the stock is only a lower bound on that mineral. The figure is then settled by the minerals with a known supply when their tightest limit is no higher than every lower bound (a mineral at 0 settles the output at 0 whatever another mineral\'s mine adds); otherwise it is unavailable, never the stock alone and never unlimited. A mine on an exhausted deposit adds nothing. At the last production tick of three saves it matched the minerals the mineral ledger logs for maintenance on every colony with facilities, those with production off giving 0 in both; colonies whose stock cannot cover a year made the rate at that tick, as the saved stock is the one after the tick. In a campaign of saves five days apart an NPR\'s colony with 246 facilities matched the minerals its deposits lost less its stock gained to within 0.02%, and a player\'s capital with 300 facilities and no Gallicite logged no maintenance in the ledger, where the rate alone would give 24,000 MSP a year. The cut of the facilities to a whole number is the game\'s own and no saved colony has a fraction, so a result that rests on it is an estimate; so is one held by the stock.',
  assumptions: ['the facilities\' output is not held back by anything but the minerals at the colony', 'the Duranium, Uridium and Gallicite the facilities use are not brought in over the year'],
})

registerRule({
  id: 'legacy.shipbuildingUse',
  versions: VERSIONS,
  units: 't/yr',
  verification: 'estimated',
  structure: ['FCT_ShipyardTask.TaskTypeID, TotalBP, CompletedBP, Paused, <mineral>, ClassID, RefitID', 'FCT_ShipClass.Size, Commercial', 'FCT_Shipyard.TaskType, SYType, Slipways, Capacity, RequiredBP, CompletedBP, PauseActivity', 'production.shipRate, production.shipyardUpgradeRate'],
  note: 'The minerals a year the race\'s shipyards take, as a forecast of the tasks and activities running now: each task builds at its colony\'s build rate, scaled by the size of the class (a commercial class counts a quarter), until its remaining build points are done, and takes its mineral columns in proportion; a yard activity takes half of its build points each of Duranium and Neutronium. Paused tasks and scrap tasks take nothing. Over one production tick the task rule matched the minerals the mineral ledger logs for shipbuilding to three decimals on every colony of two saves, bar a task added after that tick; the add-slipway and stock-activity rule matched exactly and a continual upgrade ran 0.11 to 0.14% over the ledger, as the saved capacity is the one after the tick\'s growth. The save with no shipbuilding in its ledger has no case. The year is a forecast, not a measurement.',
  assumptions: ['the tasks and yard activities running now go on at today\'s rates until they finish, and none is added', 'the minerals reach the yard as fast as the tasks take them'],
})

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const count = (amount, one, many = `${one}s`) => `${amount} ${amount === 1 ? one : many}`

const WHOLE_FACILITIES = 'the facilities are cut to a whole number, which no saved colony with a fraction of a facility has tested'

const SHARED_STOCK = 'the game takes an NPR\'s refining and maintenance minerals from the capital\'s shared stock; no saved NPR has refineries or facilities away from its capital, so that rule is not tested against a save'

const CAPITAL_STOCK = 'the capital\'s stock, which the colonies of an NPR share'

const STOCK_HELD = 'the minerals the colony holds are all it gets over the year, so the facilities make no more than they allow; a haul would let them make more'

const POOLED_COLUMNS = ['Sorium', 'Mines', ...MSP_MINERALS.flatMap((mineral) => [mineral.name, `Deposit${mineral.name}`, `DepositUnread${mineral.name}`])]

const INSTALLATION_COLUMNS = [
  { column: 'Refineries', value: 'RefineryProductionValue' },
  { column: 'MaintenanceFacilities', value: 'MaintenanceValue' },
  { column: 'Mines', value: 'MiningProductionValue' },
]

const FUEL = 'legacy.fuelUse'
const MAINTENANCE = 'legacy.maintenanceUse'
const SHIPBUILDING = 'legacy.shipbuildingUse'

// The colonies with the installation sums the fuel and maintenance rules read. A colony with no installation row has none (0); one with a row whose amount or type the save does not give has no figure (null), never 0. `Deposit<mineral>` counts the deposits of the colony's body that still hold some of the mineral, `DepositUnread<mineral>` those whose amount is not recorded. The stockpiles of fuel and maintenance supplies are not read: the uses do not depend on them.
export const legacyColoniesQuery = ({ GameID, RaceID }) => `select FCT_Population.PopulationID, FCT_Population.RaceID, FCT_Population.PopName, FCT_Population.Capital, FCT_Population.FuelProdStatus, FCT_Population.MaintProdStatus, FCT_Population.Sorium, ${MSP_MINERALS.map((mineral) => `FCT_Population.${mineral.name}`).join(', ')}, FCT_Race.NPR, FCT_Race.FuelProduction, FCT_Race.MSPProduction, ${INSTALLATION_COLUMNS.map(({ column }) => `(case when VIR_Installations.${column}Unread > 0 then null else coalesce(VIR_Installations.${column}, 0) end) as ${column}`).join(', ')}, ${MSP_MINERALS.map((mineral) => `coalesce(VIR_Deposits.Deposit${mineral.name}, 0) as Deposit${mineral.name}, coalesce(VIR_Deposits.DepositUnread${mineral.name}, 0) as DepositUnread${mineral.name}`).join(', ')} from FCT_Population inner join FCT_Race on FCT_Race.RaceID = FCT_Population.RaceID left join (select FCT_PopulationInstallations.PopID, ${INSTALLATION_COLUMNS.map(({ column, value }) => `sum(DIM_PlanetaryInstallation.${value} * FCT_PopulationInstallations.Amount) as ${column}, sum(case when DIM_PlanetaryInstallation.${value} is null or (FCT_PopulationInstallations.Amount is null and DIM_PlanetaryInstallation.${value} <> 0) then 1 else 0 end) as ${column}Unread`).join(', ')} from FCT_PopulationInstallations left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID where FCT_PopulationInstallations.GameID = ${GameID} group by FCT_PopulationInstallations.PopID) as VIR_Installations on VIR_Installations.PopID = FCT_Population.PopulationID left join (select FCT_MineralDeposit.SystemBodyID, ${MSP_MINERALS.map((mineral) => `sum(case when FCT_MineralDeposit.MaterialID = ${MINERALS.find((item) => item.name === mineral.name).id} and FCT_MineralDeposit.Amount > 0 then 1 else 0 end) as Deposit${mineral.name}, sum(case when FCT_MineralDeposit.MaterialID = ${MINERALS.find((item) => item.name === mineral.name).id} and FCT_MineralDeposit.Amount is null then 1 else 0 end) as DepositUnread${mineral.name}`).join(', ')} from FCT_MineralDeposit where FCT_MineralDeposit.GameID = ${GameID} group by FCT_MineralDeposit.SystemBodyID) as VIR_Deposits on VIR_Deposits.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID}`

// Every shipyard task with the size and commercial flag of the class it builds (the class a refit or auto-refit turns the ship into, otherwise the class itself).
export const shipyardTasksQuery = ({ GameID, RaceID }) => `select FCT_ShipyardTask.TaskID, FCT_ShipyardTask.PopulationID, FCT_ShipyardTask.TaskTypeID, FCT_ShipyardTask.TotalBP, FCT_ShipyardTask.CompletedBP, FCT_ShipyardTask.Paused, ${MINERALS.map((mineral) => `FCT_ShipyardTask.${mineral.name}`).join(', ')}, FCT_ShipClass.Size as ClassSize, FCT_ShipClass.Commercial as ClassCommercial from FCT_ShipyardTask left join FCT_ShipClass on FCT_ShipClass.ShipClassID = (case when FCT_ShipyardTask.TaskTypeID in (2, 4) then FCT_ShipyardTask.RefitID else FCT_ShipyardTask.ClassID end) where FCT_ShipyardTask.GameID = ${GameID} and FCT_ShipyardTask.RaceID = ${RaceID}`

// The shipyards that have an activity (a retool, a slipway or capacity upgrade) set.
export const shipyardActivitiesQuery = ({ GameID, RaceID }) => `select FCT_Shipyard.ShipyardID, FCT_Shipyard.PopulationID, FCT_Shipyard.SYType, FCT_Shipyard.Slipways, FCT_Shipyard.Capacity, FCT_Shipyard.TaskType, FCT_Shipyard.RequiredBP, FCT_Shipyard.CompletedBP, FCT_Shipyard.PauseActivity from FCT_Shipyard where FCT_Shipyard.GameID = ${GameID} and FCT_Shipyard.RaceID = ${RaceID} and FCT_Shipyard.TaskType <> 0`

// `result` held to at most an estimate, with `assumption` added; an unavailable one stays as it is.
const estimated = (result, assumption) => (isAvailable(result) ? envelope({ value: result.value, status: weakestStatus([result.status, 'estimated']), rule: result.rule.id, inputs: result.inputs, units: result.units, assumptions: [...result.assumptions, assumption] }) : result)

const zero = (rule, reason, units) => ofRule({ rule, value: 0, inputs: { present: [reason] }, units })

// The game cuts a colony's refinery or facility count to a whole number. `fractional` says the cut changed it, a case the saves do not hold.
const wholeCount = (value) => (isNumber(value) ? { count: Math.trunc(value), fractional: Math.trunc(value) !== value } : { count: value, fractional: false })

const modifierOf = (modifiers, populationId) => {
  const row = modifiers[populationId]

  return row && isNumber(row.OverallProductionModifier) ? row.OverallProductionModifier : null
}

// The colony as the stock it draws on: an NPR's colony away from the capital draws on the capital's stock (and the capital's mines), which its colonies share; any other colony its own. `null` when the capital is not among the rows.
const pooled = (colony, colonies) => {
  if (!colony.NPR || colony.Capital) {
    return { colony, shared: false }
  }

  const capital = colonies.find((other) => other.Capital && other.RaceID === colony.RaceID)

  return capital ? { colony: { ...colony, ...Object.fromEntries(POOLED_COLUMNS.map((column) => [column, capital[column]])) }, shared: true } : null
}

// Sorium a year (t) one colony's refineries take.
const fuelOfColony = (colony, modifiers, colonies) => {
  const { count: refineries, fractional } = wholeCount(colony.Refineries)
  const pool = refineries === 0 ? { colony, shared: false } : pooled(colony, colonies)

  if (pool === null) {
    return unavailable({ rule: FUEL, missing: [CAPITAL_STOCK] })
  }

  const result = refineries === 0 ? zero(FUEL, 'the colony has no refineries') : combine({ rule: FUEL, parts: { 'the refineries\' output': refineryYield({ ...pool.colony, Refineries: refineries }, modifierOf(modifiers, colony.PopulationID)) }, compute: (values) => values['the refineries\' output'] / LITRES_PER_TON })
  const cut = fractional ? estimated(result, WHOLE_FACILITIES) : result

  return pool.shared ? estimated(cut, SHARED_STOCK) : cut
}

// MSP a year one colony's maintenance facilities make with the minerals they need at hand: the racial rate and the colony's modifier, nothing else.
const maintenanceProduction = (colony, modifiers) => {
  const { count: facilities, fractional } = wholeCount(colony.MaintenanceFacilities)
  let result

  if (facilities === 0) {
    result = zero(MAINTENANCE, 'the colony has no maintenance facilities', 'MSP/yr')
  } else if (!isNumber(colony.MaintProdStatus)) {
    result = unavailable({ rule: MAINTENANCE, missing: ['whether maintenance production is on'], units: 'MSP/yr' })
  } else if (!colony.MaintProdStatus) {
    result = zero(MAINTENANCE, 'maintenance production is off', 'MSP/yr')
  } else {
    result = combine({ rule: MAINTENANCE, parts: { 'the MSP the facilities make': mspProduction({ ...colony, MaintenanceFacilities: facilities }, modifierOf(modifiers, colony.PopulationID)) }, compute: (values) => values['the MSP the facilities make'], units: 'MSP/yr' })
  }

  return fractional ? estimated(result, WHOLE_FACILITIES) : result
}

// What the stock of one input mineral at `stock` lets the facilities make over the year (MSP), as { low, exact, missing }: `low` the MSP the stock alone makes (0 where the stock is not in the save), `exact` whether that is all the mineral there is. It is not where a mine of `members` (the colonies that share the stock) works a body that still holds the mineral, or whose deposit amount or mine count the save does not give, and the stock falls short of `wanted`: what such a mine adds is not quantified.
const supplyOf = (stock, members, mineral, wanted) => {
  const held = stock[mineral.name]

  if (!isNumber(held)) {
    return { low: 0, exact: false, missing: `the colony's stock of ${mineral.name}` }
  }

  const low = Math.max(0, held) / mineral.perMsp
  const mines = (member) => (!isNumber(member.Mines) || member.Mines > 0) && [member[`Deposit${mineral.name}`], member[`DepositUnread${mineral.name}`]].some((amount) => !isNumber(amount) || amount > 0)
  const mined = [...new Set([...members, stock])].some(mines)

  return { low, exact: low >= wanted || !mined, missing: `the ${mineral.name} ${members.length > 1 ? 'the mines of the colonies that share the stock' : 'the colony\'s own mines'} add to its stock over the year (not quantified)` }
}

// MSP a year the maintenance facilities of `members` make together, as a result: the facilities' output, held to what the scarcest input mineral in `stock` (the stock the members draw on, null when not known) allows over the year. The members share that stock, so it is spent once: an NPR's colonies are one pool.
const maintenanceOfPool = (members, stock, modifiers) => {
  const parts = members.map((member) => maintenanceProduction(member, modifiers))
  const made = sumResults({ rule: MAINTENANCE, results: parts, units: 'MSP/yr' })

  if (!isAvailable(made) || made.value === 0) {
    return made
  } else if (stock === null) {
    return unavailable({ rule: MAINTENANCE, missing: [CAPITAL_STOCK], units: 'MSP/yr' })
  }

  const supplies = MSP_MINERALS.map((mineral) => supplyOf(stock, members, mineral, made.value))
  const settled = Math.min(made.value, ...supplies.filter((supply) => supply.exact).map((supply) => supply.low))
  const lowest = Math.min(made.value, ...supplies.map((supply) => supply.low))
  const missing = supplies.filter((supply) => !supply.exact && supply.low < settled).map((supply) => supply.missing)

  if (settled > lowest) {
    return unavailable({ rule: MAINTENANCE, missing, units: 'MSP/yr' })
  }

  const allowed = settled
  const away = members.some((member, index) => member !== stock && !(isAvailable(parts[index]) && parts[index].value === 0))
  let result = combine({ rule: MAINTENANCE, parts: { 'the MSP the facilities make': made }, compute: () => allowed, units: 'MSP/yr', inputs: { present: ['the colony\'s input mineral stock'] } })

  result = allowed < made.value ? estimated(result, STOCK_HELD) : result

  return away ? estimated(result, SHARED_STOCK) : result
}

// The maintenance of every pool of colonies that draw on one stock: an NPR's colonies draw on its capital's, any other colony on its own. `[{ members, stock }]`, `stock` null where an NPR's capital is not among the rows.
const maintenancePools = (colonies) => {
  const pools = new Map()

  colonies.forEach((colony) => {
    const key = colony.NPR ? `race ${colony.RaceID}` : `colony ${colony.PopulationID}`

    pools.set(key, [...(pools.get(key) || []), colony])
  })

  return [...pools.values()].map((members) => ({ members, stock: members[0].NPR ? colonies.find((other) => other.Capital && other.RaceID === members[0].RaceID) || null : members[0] }))
}

const TASK_TYPE_SCRAP = 3
const ACTIVITY_RETOOL = 7
const ACTIVITY_CONTINUAL = 8
const ACTIVITY_MINERALS = ['Duranium', 'Neutronium']

const byName = (names, build) => Object.fromEntries(names.map((name) => [name, build(name)]))

// What one shipyard task takes a year, by mineral name: a result for every mineral. The task builds at its colony's rate until its remaining build points are done, and takes each mineral column in proportion to the build points done.
const taskByMineral = (task, modifiers) => {
  const names = MINERALS.map((mineral) => mineral.name)
  const lacking = (missing) => byName(names, () => unavailable({ rule: SHIPBUILDING, missing }))
  const idle = (reason) => byName(names, () => zero(SHIPBUILDING, reason))

  if (!isNumber(task.TaskTypeID)) {
    return lacking(['the task type'])
  } else if (task.TaskTypeID === TASK_TYPE_SCRAP) {
    return idle('a scrap task builds nothing')
  } else if (!isNumber(task.Paused)) {
    return lacking(['whether the task is paused'])
  } else if (task.Paused) {
    return idle('the task is paused')
  }

  const missing = [...(isNumber(task.TotalBP) && task.TotalBP > 0 ? [] : ['the task\'s build points']), ...(isNumber(task.CompletedBP) ? [] : ['the build points of the task done']), ...(isNumber(task.ClassSize) && isNumber(task.ClassCommercial) ? [] : ['the size and type of the class the task builds'])]

  if (missing.length) {
    return lacking(missing)
  }

  const rate = shipRate(modifiers[task.PopulationID], { Size: task.ClassSize, CommercialModifier: task.ClassCommercial ? 0.25 : 1 })
  const points = combine({ rule: SHIPBUILDING, parts: { 'the task\'s build rate': rate }, compute: (values) => Math.min(values['the task\'s build rate'], Math.max(0, task.TotalBP - task.CompletedBP)), units: 'BP/yr' })

  return byName(names, (name) => (isNumber(task[name]) ? combine({ rule: SHIPBUILDING, parts: { 'the build points of the year': points }, compute: (values) => (values['the build points of the year'] * task[name]) / task.TotalBP }) : unavailable({ rule: SHIPBUILDING, missing: [`the ${name} the task needs`] })))
}

// What one shipyard activity takes a year, by mineral name (Duranium and Neutronium only): half its build points of each. A retool builds with every slipway; a continual upgrade has no end and is held at today's capacity, though it grows.
const activityByMineral = (yard, modifiers) => {
  const lacking = (missing) => byName(ACTIVITY_MINERALS, () => unavailable({ rule: SHIPBUILDING, missing }))
  const continual = yard.TaskType === ACTIVITY_CONTINUAL
  const retool = yard.TaskType === ACTIVITY_RETOOL

  if (!isNumber(yard.PauseActivity)) {
    return lacking(['whether the yard activity is paused'])
  } else if (yard.PauseActivity) {
    return byName(ACTIVITY_MINERALS, () => zero(SHIPBUILDING, 'the yard activity is paused'))
  }

  const missing = [...(retool && !isNumber(yard.Slipways) ? ['the yard\'s slipways'] : []), ...(!continual && !(isNumber(yard.RequiredBP) && isNumber(yard.CompletedBP)) ? ['the build points the activity needs and has done'] : [])]

  if (missing.length) {
    return lacking(missing)
  }

  const rate = shipyardUpgradeRate(modifiers[yard.PopulationID], yard)
  const points = combine({
    rule: SHIPBUILDING,
    parts: { 'the activity\'s build rate': rate },
    compute: (values) => {
      const perYear = values['the activity\'s build rate'] * (retool ? yard.Slipways : 1)

      return continual ? perYear : Math.min(perYear, Math.max(0, yard.RequiredBP - yard.CompletedBP))
    },
    units: 'BP/yr',
    assumptions: continual ? ['a continual upgrade is held at the yard\'s capacity today, though the upgrade raises it'] : [],
  })

  return byName(ACTIVITY_MINERALS, () => combine({ rule: SHIPBUILDING, parts: { 'the build points of the year': points }, compute: (values) => values['the build points of the year'] / 2 }))
}

// The modelled uses of a race's fuel refineries, maintenance facilities and shipyards, `{ fuel, maintenance, shipbuilding }`, each `{ byMineral, basis }`: `byMineral` the result of 'legacy.*Use' of every mineral the use takes (a mineral it does not take has no entry), `basis` a line saying what the figures stand on. A colony, task or yard that lacks an input makes the minerals it takes unavailable, naming it. `colonies`, `tasks`, `activities`: rows of the queries above; `modifiers`: the page's `populationProductionModifiers`.
export const legacyModels = ({ colonies, tasks, activities, modifiers }) => {
  const fuel = colonies.map((colony) => fuelOfColony(colony, modifiers, colonies))
  const msp = maintenancePools(colonies).map(({ members, stock }) => maintenanceOfPool(members, stock, modifiers))
  const usesOf = [...tasks.map((task) => taskByMineral(task, modifiers)), ...activities.map((yard) => activityByMineral(yard, modifiers))]
  const refineries = colonies.reduce((total, colony) => total + (isNumber(colony.Refineries) ? Math.trunc(colony.Refineries) : 0), 0)
  const facilities = colonies.reduce((total, colony) => total + (isNumber(colony.MaintenanceFacilities) ? Math.trunc(colony.MaintenanceFacilities) : 0), 0)
  const running = tasks.filter((task) => task.TaskTypeID !== TASK_TYPE_SCRAP && !task.Paused).length
  const yards = activities.filter((yard) => !yard.PauseActivity).length

  return {
    fuel: {
      byMineral: { Sorium: sumResults({ rule: FUEL, results: fuel }) },
      basis: `${count(refineries, 'refinery', 'refineries')} at ${count(colonies.filter((colony) => Math.trunc(colony.Refineries) > 0).length, 'colony', 'colonies')}`,
    },
    maintenance: {
      byMineral: byName(MSP_MINERALS.map((mineral) => mineral.name), (name) => sumResults({ rule: MAINTENANCE, results: msp.map((made) => combine({ rule: MAINTENANCE, parts: { 'the MSP made': made }, compute: (values) => values['the MSP made'] * MSP_MINERALS.find((mineral) => mineral.name === name).perMsp, units: 't/yr' })) })),
      basis: `${count(facilities, 'maintenance facility', 'maintenance facilities')} at ${count(colonies.filter((colony) => Math.trunc(colony.MaintenanceFacilities) > 0).length, 'colony', 'colonies')}`,
    },
    shipbuilding: {
      byMineral: byName(MINERALS.map((mineral) => mineral.name), (name) => sumResults({ rule: SHIPBUILDING, results: usesOf.map((uses) => uses[name]).filter(Boolean) })),
      basis: `${count(running, 'task')} and ${count(yards, 'yard activity', 'yard activities')} running`,
    },
  }
}

// The line the page gives for the industry queue's basis. An NPR's ordnance projects are not charged to its minerals in the game; no save holds such a case, so the line says the queue figure may overstate it. `projects`: the rows of the industrial project read; `npr`: whether the race is an NPR.
export const industryBasis = ({ projects, npr }) => {
  const queue = `${count(projects.length, 'project')} queued or running`

  return npr && projects.some((project) => project.ProductionType === 1) ? `${queue}; an NPR's ordnance is not charged to its minerals in the game, so the queue may overstate its use (no saved case)` : queue
}
