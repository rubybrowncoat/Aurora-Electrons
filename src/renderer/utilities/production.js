// The calculations behind the Production page: what each colony can build, research and train, what is idle, and when each job finishes. Every figure is a provenance result (utilities/provenance.js): a missing input gives an unavailable result naming it, never 0, and a job that is not making progress gives an unavailable finish that says so. The colony's production modifiers and its construction, ordnance and fighter capacity come from the production-modifiers mixin (rule `production.populationCapacity`).

import { admitQueued, forecastColonySteps, FUEL, HORIZON_DAYS } from './industry-cycle'
import { TERMINATION, UNPACED } from './search-run'
import { MINERALS, projectShortages } from './minerals'
import { combine, isAvailable, ofRule, registerRule, sumResults, unavailable } from './provenance'

const PRODUCTION_VERSIONS = ['2.7.x']
const SECONDS_PER_YEAR = 31536000
const SECONDS_PER_DAY = 86400
const DAYS_PER_YEAR = 365
const EARTH_SURFACE_AREA = 511187128

// Water vapour, as the game has it: condensation a year, hydrographic extent per atm, relative humidity factor.
const CONDENSATION_PER_YEAR = 0.1
const CONDENSATION_TO_HYDRO_RATE = 40
const WATER_VAPOUR_IN_ATMOSPHERE = 0.01
// How far ahead the water vapour estimate looks.
export const WATER_VAPOUR_HORIZON = 200

const ESTIMATE = 'The rate is not compared with a saved figure of the job.'

registerRule({
  id: 'production.jobCount',
  versions: PRODUCTION_VERSIONS,
  units: 'jobs',
  verification: 'confirmed',
  structure: ['FCT_ResearchProject', 'FCT_IndustrialProjects.Queue, Pause', 'FCT_ShipyardTask', 'FCT_Shipyard.TaskType, PauseActivity', 'FCT_GroundUnitTraining', 'FCT_Population.TerraformingGasID, MaxAtm'],
  note: 'A count of the save\'s research projects, industrial projects, shipyard tasks and activities, ground training tasks and terraforming colonies. Queued jobs are counted apart from the running ones; a colony adding a gas up to 0 atm has no terraforming job.',
})

registerRule({
  id: 'production.capacityFree',
  versions: PRODUCTION_VERSIONS,
  units: 'BP/yr',
  verification: 'estimated',
  structure: ['production.populationCapacity', 'production.trainingCapacity', 'FCT_IndustrialProjects.Percentage, Queue, Pause, ProductionType', 'FCT_GroundUnitTraining.TaskPercentage'],
  note: 'A colony\'s capacity for construction, ordnance, fighters or ground training times the share no running project or task uses. A queued project holds no share and a paused one keeps its share without building, so it counts as idle. The capacity is estimated; the shares are stored percentages.',
})

registerRule({
  id: 'production.trainingCapacity',
  versions: PRODUCTION_VERSIONS,
  units: 'BP/yr',
  verification: 'estimated',
  structure: ['FCT_Race.GroundFormationConstructionRate, EconomicProdModifier', 'FCT_Species.ProductionRateModifier', 'FCT_Population.Efficiency, UnrestPoints', 'FCT_SystemBody.RadiationLevel', 'FCT_Commander, FCT_CommanderBonuses', 'DIM_PlanetaryInstallation.GroundTrainingValue', 'FCT_PopulationInstallations.Amount'],
  note: 'The race\'s ground formation construction rate with the colony\'s modifiers (governor and sector Ground Unit bonus, species rate, economy, efficiency, radiation, stability and political status) times the colony\'s ground force construction complexes. The modifier is not compared with a saved build rate of a training task.',
})

registerRule({
  id: 'production.researchLabs',
  versions: PRODUCTION_VERSIONS,
  units: 'labs',
  verification: 'confirmed',
  structure: ['DIM_PlanetaryInstallation.ResearchValue', 'FCT_PopulationInstallations.Amount', 'FCT_ResearchProject.Facilities'],
  note: 'The research facilities installed at a colony (amount times the installation\'s research value) and the facilities its projects hold; idle is the difference. A colony whose projects hold more than are installed has 0 idle and says so.',
})

registerRule({
  id: 'production.slipways',
  versions: PRODUCTION_VERSIONS,
  units: 'slipways',
  verification: 'confirmed',
  structure: ['FCT_Shipyard.Slipways', 'FCT_ShipyardTask.ShipyardID'],
  note: 'The slipways of a colony\'s shipyards and the slipways with a task (a yard\'s tasks up to its slipways, as the game\'s shipyard list counts them); idle is the difference. A colony with more tasks than slipways has 0 idle.',
})

registerRule({
  id: 'production.researchRate',
  versions: PRODUCTION_VERSIONS,
  units: 'RP/yr',
  verification: 'estimated',
  structure: ['FCT_ResearchProject.Facilities', 'FCT_Commander.ResSpecID', 'FCT_CommanderBonuses (Research)', 'FCT_AncientConstruct.ResearchField, ResearchBonus', 'FCT_Race.Research', 'FCT_Species.ResearchRateModifier', 'FCT_Game.ResearchSpeed'],
  note: `The project's facilities times the colony's overall research modifier (race and species rate, economy, efficiency, radiation, stability, political status and the game's research speed) times the scientist's Research bonus (four times the bonus less 3 in the scientist's own field, the bonus itself outside it) times the anomaly bonus. ${ESTIMATE}`,
  assumptions: ['A project with no scientist, or a scientist without the Research bonus, takes no bonus (×1)'],
})

registerRule({
  id: 'production.industryRate',
  versions: PRODUCTION_VERSIONS,
  units: 'BP/yr',
  verification: 'estimated',
  structure: ['production.populationCapacity', 'FCT_IndustrialProjects.Percentage'],
  note: `The colony's capacity for the project's kind (construction, ordnance or fighters) times the project's share. The share is stored; the capacity is estimated. ${ESTIMATE}`,
})

registerRule({
  id: 'production.shipRate',
  versions: PRODUCTION_VERSIONS,
  units: 'BP/yr',
  verification: 'estimated',
  structure: ['FCT_Population (shipbuilding modifiers)', 'FCT_ShipClass.Size', 'FCT_Shipyard.SYType'],
  note: `The colony's shipyard build rate times a factor for the class's size: half of one plus the size in hull spaces over 100 (a quarter of it at a military yard). ${ESTIMATE}`,
})

registerRule({
  id: 'production.shipyardUpgradeRate',
  versions: PRODUCTION_VERSIONS,
  units: 'BP/yr',
  verification: 'estimated',
  structure: ['FCT_Population (shipbuilding modifiers)', 'FCT_Shipyard.Capacity, SYType'],
  note: `The colony's shipyard build rate times a factor for the yard's capacity: half of one plus the capacity over 5,000 tons (a tenth of it at a military yard). ${ESTIMATE}`,
})

registerRule({
  id: 'production.trainingRate',
  versions: PRODUCTION_VERSIONS,
  units: 'BP/yr',
  verification: 'estimated',
  structure: ['production.trainingCapacity', 'FCT_GroundUnitTraining.TaskPercentage'],
  note: `The colony's ground training capacity times the task's share. The share is stored; the capacity is estimated. ${ESTIMATE}`,
})

registerRule({
  id: 'production.terraformRate',
  versions: PRODUCTION_VERSIONS,
  units: 'atm/yr',
  verification: 'estimated',
  structure: ['FCT_Race.TerraformingRate', 'FCT_Game.TerraformingSpeed', 'FCT_Commander, FCT_CommanderBonuses (Terraforming)', 'DIM_PlanetaryInstallation.TerraformValue', 'FCT_ShipClass.Terraformers, Crew', 'FCT_Ship.CurrentCrew', 'crew.terraforming', 'FCT_SystemBody.Radius'],
  note: `The terraformers' rate (planetary installations at the colony's rate, orbital terraformers at the race's rate times the naval admin chain's Terraforming bonus, each ship at the share of its class crew aboard) times the game's terraforming speed, spread over the body's surface against the Earth's. ${ESTIMATE}`,
  assumptions: ['A terraformer ship whose commander has no Terraforming bonus counts it as ×1', 'An orbital terraformer works at the share of its class crew aboard; its damaged modules are not excluded'],
})

registerRule({
  id: 'production.shipyardContinual',
  versions: PRODUCTION_VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['FCT_Shipyard.Capacity, CapacityTarget, Slipways, SYType', 'FCT_Race.ShipyardOperations', 'FCT_Game.MinConstructionPeriod'],
  note: 'The days a continual capacity upgrade takes to reach its target capacity: each construction period the yard adds the capacity its upgrade rate buys, until the target is reached. The step is the game\'s order of work approximated, so the date is approximate and is marked with a ~.',
  assumptions: ['The date is approximate: the game\'s own steps are not reproduced exactly'],
})

;[
  { key: 'research', note: 'The remaining research points over the project\'s rate, in days. A queued tech starts when the one ahead finishes, with the same labs.' },
  { key: 'industry', note: 'The project\'s remaining build points (units left times the points a unit takes) over its rate, in days, for a colony the save gives every input of: the colony\'s production cycles run forward one by one, each project building its share of the capacity, rounded to 4 decimals a cycle and cut to what the colony\'s one stock of each mineral and the fuel covers after the projects ahead of it in the cycle, so the day is the end of the cycle the project finishes in. A queued project starts when a project of its kind finishes and leaves enough share, and builds from the next cycle. Where two projects want the same stock and the order the game takes them in is not saved, the date is the earliest over the orders tried, with its range; a project the stock cannot finish has no date. For a colony missing an input it is the points over the rate with the minerals not simulated, a queued project starting the moment the one ahead finishes.' },
  { key: 'ship', note: 'The task\'s remaining build points over the yard\'s rate, in days. Minerals are not simulated.' },
  { key: 'shipyardUpgrade', note: 'The activity\'s remaining build points over the yard\'s rate, in days, shared among the slipways of a retool.' },
  { key: 'training', note: 'The task\'s remaining build points over its rate, in days.' },
  { key: 'terraform', note: 'The pressure still to add or remove over the local rate, in days; for water vapour over liquid water, the construction cycles it takes as the vapour condenses and the oceans evaporate. Not within 200 years reads as no date.' },
].forEach(({ key, note }) => registerRule({ id: `production.${key}Finish`, versions: PRODUCTION_VERSIONS, units: 'days', verification: 'estimated', structure: [`production.${key}Rate`], note: `${note} ${ESTIMATE}` }))

registerRule({
  id: 'production.timeline',
  versions: PRODUCTION_VERSIONS,
  units: 'jobs',
  verification: 'estimated',
  structure: ['production.researchFinish, industryFinish, shipFinish, shipyardUpgradeFinish, trainingFinish, terraformFinish'],
  note: 'The jobs shown, binned by the day they finish: the day count over the bin length, floored. Jobs that are paused, never start or have no finish time known are left out and counted apart; a job past the last bin counts as later. The finish days are estimated.',
})

registerRule({
  id: 'production.shortage',
  versions: PRODUCTION_VERSIONS,
  units: 'units',
  verification: 'confirmed',
  structure: ['FCT_IndustrialProjects.Amount, FuelRequired and the mineral columns', 'FCT_Population mineral stockpiles and FuelStockpile'],
  note: 'The units of a project the colony\'s own stock covers (stock over the project\'s need a unit, for each mineral and the fuel) against the units left. Stock arriving later is not counted.',
})

registerRule({
  id: 'production.stockCover',
  versions: PRODUCTION_VERSIONS,
  units: 'units',
  verification: 'estimated',
  structure: ['FCT_IndustrialProjects.Amount, PartialCompletion, FuelRequired and the mineral columns', 'FCT_Population mineral stockpiles and FuelStockpile', 'production.industryFinish'],
  note: 'The units of a project the colony\'s stock lets it build before a mineral or the fuel runs out, the stock being shared with the colony\'s other projects and no arrival entered brings more. Where the order the game takes the projects in is not saved the figure is the fewest the orders tried give, and the most is shown beside it.',
  assumptions: ['The order the game takes a colony\'s projects in each cycle is not saved'],
})

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// A 0 or 1 flag column as true or false, null when the save does not hold one.
export const flagOf = (value) => (value === 0 || value === 1 ? Boolean(value) : null)

const MODIFIER_TEXT = {
  row: 'the colony\'s production modifiers',
  ShipyardBuildRate: 'the colony\'s shipyard build rate',
  OverallResearchModifier: 'the colony\'s research modifier',
  OverallGroundUnitModifier: 'the colony\'s ground formation construction rate',
  TerraformingRate: 'the race\'s terraforming rate',
  PopulationTerraformingRate: 'the colony\'s terraforming rate',
  TerraformingSpeed: 'the game\'s terraforming speed',
  MinConstructionPeriod: 'the game\'s construction period',
  ShipyardOperations: 'the race\'s shipyard operations',
}

// What the colony's modifiers row lacks of `keys`: its own text when the row is not there at all.
const modifierGaps = (modifiers, keys) => (modifiers ? keys.filter((key) => !isNumber(modifiers[key])).map((key) => MODIFIER_TEXT[key]) : [MODIFIER_TEXT.row])

// The capacity a project draws on: ordnance and fighters have their own, and everything else, components and space stations included, uses construction capacity. A project with no production type in the save draws on a capacity not known: 'unknown', never construction.
export const categoryOf = (productionType) => (!isNumber(productionType) ? 'unknown' : productionType === 1 ? 'ordnance' : productionType === 2 ? 'fighter' : 'construction')

// The capacity of a project whose production type is not in the save: unavailable, naming the type, so the project's rate and finish are unavailable with it.
export const unknownKindCapacity = () => unavailable({ rule: 'production.industryRate', missing: ['the project\'s production type'] })

// Whether an industrial project is running now (not queued, not paused): true or false, null while its queue place or pause flag is not in the save. A project known to be queued or paused is not running whatever else is missing.
const industryRunning = (project) => {
  if ((isNumber(project.Queue) && project.Queue > 0) || flagOf(project.Paused) === true) {
    return false
  }

  return isNumber(project.Queue) && flagOf(project.Paused) !== null ? true : null
}

// What each colony's projects with no production type leave undecided about its current shares, as { [PopulationID]: [text] }: a project of unknown category that is not known to be queued or paused may hold a share of any of the colony's capacities, so none of their shares can be told. A colony without such a project is not in the map. A paused or queued one draws nothing now; what it does to the starts behind it is `undecidedStarts`.
export const undecidedKinds = (projects) => {
  const undecided = {}

  projects.forEach((project) => {
    if (categoryOf(project.ProductionType) === 'unknown' && industryRunning(project) !== false) {
      ;(undecided[project.PopulationID] = undecided[project.PopulationID] || []).push(`the production type of ${typeof project.Name === 'string' && project.Name ? `the project ${project.Name}` : 'a project'}, which may be running`)
    }
  })

  return undecided
}

// What each colony's projects with no production type leave undecided about the schedules of its capacities, as { [PopulationID]: [{ text, project, ahead }] }: `project` the row itself, so `industryFigures` can try it as part of a group, and `ahead` the ProjectIDs of the colony's rows before it in the order given, so it takes its own place among them (the scheduler breaks a tie of finish or queue place by that order). A colony without such a project is not in the map.
export const undecidedStarts = (projects) => {
  const undecided = {}
  const seen = {}

  projects.forEach((project) => {
    const ahead = (seen[project.PopulationID] = seen[project.PopulationID] || [])

    if (categoryOf(project.ProductionType) === 'unknown') {
      const state = isNumber(project.Queue) && project.Queue > 0 ? 'which is queued' : flagOf(project.Paused) === true ? 'which keeps its share while paused' : 'which may be running'

      ;(undecided[project.PopulationID] = undecided[project.PopulationID] || []).push({ text: `the production type of ${typeof project.Name === 'string' && project.Name ? `the project ${project.Name}` : 'a project'}, ${state}`, project, ahead: new Set(ahead) })
    }

    ahead.push(project.ID)
  })

  return undecided
}

const CATEGORIES = ['construction', 'ordnance', 'fighter']

// The share of each colony and category (key `<PopulationID>-<category>`) the running projects use, as { [key]: { used, missing } }; `missing` names what the save lacks of a project that may be running. A key with no project is not in the map: nothing uses it. A running project with no production type holds a share of a capacity not known, so every category of its colony names it as missing and none is charged.
export const industryUsage = (projects) => {
  const usage = {}
  const entryOf = (key) => (usage[key] = usage[key] || { used: 0, missing: [] })

  Object.entries(undecidedKinds(projects)).forEach(([populationId, texts]) => {
    CATEGORIES.forEach((category) => entryOf(`${populationId}-${category}`).missing.push(...texts))
  })

  projects.forEach((project) => {
    const category = categoryOf(project.ProductionType)

    if (category === 'unknown') {
      return
    }

    const entry = entryOf(`${project.PopulationID}-${category}`)
    const running = industryRunning(project)

    if (running === null) {
      entry.missing.push('whether a project is queued or paused')
    } else if (running && !isNumber(project.Percentage)) {
      entry.missing.push('a running project\'s share of the capacity')
    } else if (running) {
      entry.used += project.Percentage
    }
  })

  return usage
}

// The share each colony's training tasks use, as { [PopulationID]: { used, missing } }.
export const trainingUsage = (trainings) => {
  const usage = {}

  trainings.forEach((training) => {
    const entry = (usage[training.PopulationID] = usage[training.PopulationID] || { used: 0, missing: [] })

    if (isNumber(training.TaskPercentage)) {
      entry.used += training.TaskPercentage
    } else {
      entry.missing.push('a training task\'s share')
    }
  })

  return usage
}

// BP a year the colony's GFCCs train at 100%: the race's rate per GFCC with its bonuses, times the GFCCs. `facilities`: the colony's row with `TrainingFacilities`, undefined when the colony has none read.
export const trainingCapacity = (modifiers, facilities) => {
  const rule = 'production.trainingCapacity'
  const missing = [...modifierGaps(modifiers, ['OverallGroundUnitModifier']), ...(facilities && isNumber(facilities.TrainingFacilities) ? [] : ['the colony\'s ground force construction complexes'])]

  if (missing.length) {
    return unavailable({ rule, missing })
  }

  return ofRule({ rule, value: modifiers.OverallGroundUnitModifier * facilities.TrainingFacilities, inputs: { present: [MODIFIER_TEXT.OverallGroundUnitModifier, 'the colony\'s ground force construction complexes'] } })
}

// A capacity result (`total`) and the share the running work uses (`usage`, { used, missing } or undefined for none): { total, free } where free is the part no running work uses, unavailable while the capacity or a share is not known. Work holding more than 100% leaves nothing idle and the result says so.
export const freeCapacity = (total, usage) => {
  const rule = 'production.capacityFree'
  const missing = usage ? usage.missing : []
  const used = usage ? usage.used : 0

  if (missing.length) {
    return { total, free: unavailable({ rule, missing: [...(total.inputs.missing || []), ...missing], present: total.inputs.present }) }
  }

  const share = Math.max(0, 100 - used) / 100

  return { total, free: combine({ rule, parts: { total }, compute: (values) => values.total * share, inputs: { present: ['the running work\'s shares'] }, assumptions: used > 100 ? [`The running work holds ${used}% of the capacity, so nothing is idle`] : [] }) }
}

const FACILITIES = {
  research: { rule: 'production.researchLabs', total: 'ResearchFacilities', used: 'ResearchFacilitiesUsed', totalText: 'the research facilities installed', usedText: 'the research facilities the projects hold' },
  slipways: { rule: 'production.slipways', total: 'Slipways', used: 'SlipwaysUsed', totalText: 'the slipways of the shipyards', usedText: 'the slipways with a task' },
}

// A colony's installed facilities of `kind` ('research' or 'slipways') and the idle ones, as { total, free } results: free is total less used, never below 0; it is unavailable while either count is not in the save. `colony`: the row of the colony facilities read.
export const idleFacilities = (colony, kind) => {
  const { rule, total: totalKey, used: usedKey, totalText, usedText } = FACILITIES[kind]
  const count = (key, text) => (isNumber(colony[key]) ? ofRule({ rule, value: colony[key], inputs: { present: [text] } }) : unavailable({ rule, missing: [text] }))
  const total = count(totalKey, totalText)
  const used = count(usedKey, usedText)
  const over = isAvailable(total) && isAvailable(used) && used.value > total.value

  return { total, free: combine({ rule, parts: { total, used }, compute: (values) => Math.max(0, values.total - values.used), assumptions: over ? [`${used.value} ${kind === 'research' ? 'facilities are held' : 'slipways have a task'} against ${total.value} installed, so none are idle`] : [] }) }
}

// The sum of the available results of one rule, with how many were left out: { result, unknown }. A group with none is a known 0; one that has results only unavailable is unavailable. The result says how many it did not count.
export const totalOf = (rule, results, noun) => {
  const known = results.filter(isAvailable)
  const unknown = results.length - known.length

  if (!known.length && unknown) {
    return { result: unavailable({ rule, missing: [`the figure of each of the ${unknown} ${noun}`] }), unknown }
  }

  return { result: sumResults({ rule, results: known, assumptions: unknown ? [`${unknown} ${noun} have no figure and are not counted`] : [] }), unknown }
}

// A flag-aware reason a job is not making progress, for a finish that is not a date.
const idle = (rule, reason, present = []) => ({ result: unavailable({ rule, missing: [reason], present }), idle: true })

// A job's finish in days from now, as { result, idle }: `result` a 'production.<kind>Finish' (`rule`) result, unavailable when the job has no finish; `idle` that this is no input missing but a job that is not progressing (paused, nothing to work with, a start that never comes). `rate`: the job's rate result; `remaining`: the work left, `remainingName` its name; `paused`: true, false or null; `divisor` shares the work (the slipways of a retool); `ahead`: the finish of the job it waits for, a queued job's start.
export const finishDays = ({ rule, rate, remaining, remainingName, paused = false, divisor = 1, ahead = null }) => {
  if (paused === null) {
    return { result: unavailable({ rule, missing: ['whether the job is paused'] }), idle: false }
  } else if (paused) {
    return idle(rule, 'a job that is making progress (it is paused)')
  } else if (ahead && !isAvailable(ahead.result)) {
    return ahead.idle ? idle(rule, 'a start (the job ahead makes no progress)') : { result: unavailable({ rule, missing: ahead.result.inputs.missing, present: ahead.result.inputs.present }), idle: false }
  }

  const parts = ahead ? { rate, ahead: ahead.result } : { rate }

  if (!isAvailable(rate)) {
    return { result: combine({ rule, parts, compute: () => 0 }), idle: false }
  } else if (!isNumber(remaining)) {
    return { result: unavailable({ rule, missing: [remainingName], present: rate.inputs.present }), idle: false }
  } else if (!isNumber(divisor) || !(divisor > 0)) {
    return { result: unavailable({ rule, missing: ['at least one slipway'], present: rate.inputs.present }), idle: false }
  } else if (!(rate.value > 0)) {
    return idle(rule, 'a rate above 0 (no capacity or share to work with)', rate.inputs.present)
  }

  return { result: combine({ rule, parts, compute: (values) => (ahead ? values.ahead : 0) + ((remaining / values.rate) * DAYS_PER_YEAR) / divisor, inputs: { present: [remainingName] } }), idle: false }
}

// A job's status from its pause flag and its rate result (or, for work whose rate alone does not say, its finish `{ result, idle }`): paused, running, stalled (`stalled` is its { label, note }) or unknown while the pause flag or the rate is not known.
export const jobStatus = ({ paused, rate, stalled, finish = null }) => {
  if (paused === null) {
    return { id: 'unknown', label: 'Not known', note: 'Whether it is paused is not in the save' }
  } else if (paused) {
    return { id: 'paused', label: 'Paused' }
  } else if (finish) {
    return isAvailable(finish.result) ? { id: 'running', label: 'Running' } : finish.idle ? { id: 'stalled', ...stalled } : { id: 'unknown', label: 'Not known', note: `Missing ${finish.result.inputs.missing.join(', ')}` }
  } else if (!isAvailable(rate)) {
    return { id: 'unknown', label: 'Not known', note: `Missing ${rate.inputs.missing.join(', ')}` }
  }

  return rate.value > 0 ? { id: 'running', label: 'Running' } : { id: 'stalled', ...stalled }
}

// A research project's rate in RP a year: the project's facilities times the colony's research modifier and the bonuses. `project`: { Facilities, ActualCommanderResearchBonus, ActualAnomalyBonus, CommanderField }.
export const researchRate = (modifiers, project) => {
  const rule = 'production.researchRate'
  const missing = [...modifierGaps(modifiers, ['OverallResearchModifier']), ...(isNumber(project.Facilities) ? [] : ['the facilities the project holds']), ...(isNumber(project.ActualCommanderResearchBonus) ? [] : ['the scientist\'s research bonus']), ...(isNumber(project.ActualAnomalyBonus) ? [] : ['the anomaly bonus'])]

  if (missing.length) {
    return unavailable({ rule, missing })
  }

  return ofRule({ rule, value: project.ActualCommanderResearchBonus * project.ActualAnomalyBonus * modifiers.OverallResearchModifier * project.Facilities, inputs: { present: [MODIFIER_TEXT.OverallResearchModifier, 'the project\'s facilities and bonuses'] }, assumptions: project.CommanderField ? [] : ['No scientist is assigned, so the project takes no research bonus (×1)'] })
}

// The project a queued tech runs as: the same labs, the scientist's bonus out of his field (the bonus itself) or in it (four times it less 3, as the project's query gives it), and the anomaly bonus only in the project's field.
export const queuedResearch = (project, queue) => {
  const inField = project.ProjectField === queue.ProjectField

  return { ...project, ActualCommanderResearchBonus: inField ? project.ActualCommanderResearchBonus : project.CommanderBonus, ActualAnomalyBonus: inField ? project.ActualAnomalyBonus : 1 }
}

// When each industrial project of one colony and category starts and finishes, in days from now, as the game runs them. Every project out of the queue builds at its share of the capacity; a paused one keeps its share and builds nothing. When a project finishes, the queued ones start in queue order, each that fits in the share the running and paused ones leave, skipping any that don't, until none is left. Minerals aren't simulated. `capacity`: BP a year at 100%. Returns { [ProjectID]: { start, finish } }, null where that never happens.
export const industrySchedule = (projects, capacity) => {
  const schedule = {}
  const running = []
  let used = 0

  const begin = (project, start) => {
    const rate = (capacity * project.Percentage) / 100
    const finish = project.Paused || !(rate > 0) ? null : start + ((project.Amount * project.ProdPerUnit) / rate) * DAYS_PER_YEAR

    used += project.Percentage
    schedule[project.ID] = { start, finish }

    if (finish !== null) {
      running.push({ project, finish })
    }
  }

  projects.filter((project) => !project.Queue).forEach((project) => begin(project, 0))

  let queue = projects.filter((project) => project.Queue > 0).sort((a, b) => a.Queue - b.Queue)

  while (queue.length && running.length) {
    running.sort((a, b) => a.finish - b.finish)

    const done = running.shift()

    used -= done.project.Percentage

    const { started, waiting } = admitQueued(queue, used)

    started.forEach((project) => begin(project, done.finish))
    queue = waiting
  }

  queue.forEach((project) => {
    schedule[project.ID] = { start: null, finish: null }
  })

  return schedule
}

// A project's rate in BP a year: the colony's capacity for its kind (a result) times the project's share. Unavailable while the capacity or the share is not known.
const projectRate = (capacity, project) => {
  const rule = 'production.industryRate'

  return !isNumber(project.Percentage) ? unavailable({ rule, missing: [...capacity.inputs.missing, 'the project\'s share of the capacity'], present: capacity.inputs.present }) : combine({ rule, parts: { capacity }, compute: (values) => (values.capacity * project.Percentage) / 100, inputs: { present: ['the project\'s share of the capacity'] } })
}

const SCHEDULE_FIELDS = { Queue: 'a project\'s queue place', Paused: 'whether a project is paused', Percentage: 'a project\'s share of the capacity', Amount: 'a project\'s units left', ProdPerUnit: 'a project\'s build points per unit' }

// The most unknown-category projects of a colony whose every resolution is tried; with more, every queued start of the colony is left unknown.
const MAX_TRIED_UNDECIDED = 4

// The industrial projects of one colony and category with their rate and finish, in the order given: [{ rate, finish, start }], `rate` a 'production.industryRate' result, `finish` a { result, idle } of 'production.industryFinish' and `start` the days until a queued project starts (null when it never does or is not known). `capacity`: the colony's 'production.populationCapacity' result for the category. A project that runs now needs only its own figures and the capacity; a queued one needs those of every project of the group, since the ones ahead of it set when it starts. `undecided`: the colony's projects of unknown category (from `undecidedStarts`). Each of them is in this group or in another capacity, so the schedule is run for every combination of those two outcomes (the real scheduler, which skips a project that does not fit and admits a later one) and a start or finish is kept only when it is the same in all of them; otherwise it is unavailable and names the projects whose resolution changes it. With more than `MAX_TRIED_UNDECIDED` such projects, or one without its own figures, every queued project of the group is unavailable and names them all. A project that runs now is the same in every combination.
export const industryFigures = (group, capacity, undecided = []) => {
  const finishRule = 'production.industryFinish'
  const gaps = (project) => Object.keys(SCHEDULE_FIELDS).filter((key) => !isNumber(project[key])).map((key) => SCHEDULE_FIELDS[key])
  const groupGaps = [...new Set(group.flatMap(gaps))]
  const schedule = isAvailable(capacity) && !groupGaps.length ? industrySchedule(group, capacity.value) : null
  const swayed = {}

  if (schedule && undecided.length) {
    if (undecided.length > MAX_TRIED_UNDECIDED || undecided.some((entry) => gaps(entry.project).length)) {
      group.filter((project) => project.Queue > 0).forEach((project) => (swayed[project.ID] = undecided.map((entry) => entry.text)))
    } else {
      const withUnknown = (mask) => {
        const chosen = undecided.filter((_entry, index) => mask & (2 ** index))
        const placed = (index) => chosen.filter((entry) => group.filter((project) => entry.ahead.has(project.ID)).length === index).map((entry) => entry.project)

        return [...group.flatMap((project, index) => [...placed(index), project]), ...placed(group.length)]
      }
      const runs = Array.from({ length: 2 ** undecided.length }, (_, mask) => industrySchedule(withUnknown(mask), capacity.value))

      group.forEach((project) => {
        const figure = (run) => JSON.stringify(run[project.ID])

        if (!runs.every((run) => figure(run) === figure(runs[0]))) {
          swayed[project.ID] = undecided.filter((_entry, index) => runs.some((run, mask) => !(mask & (2 ** index)) && figure(run) !== figure(runs[mask + 2 ** index]))).map((entry) => entry.text)
        }
      })
    }
  }

  const stalled = (project) => (project.Paused ? 'a job that is making progress (it is paused)' : 'a rate above 0 (no capacity or share to work with)')
  const dated = (rate, days) => ({ result: combine({ rule: finishRule, parts: { rate }, compute: () => days, inputs: { present: ['the units left and the points a unit takes'] } }), idle: false })

  return group.map((project) => {
    const rate = projectRate(capacity, project)

    const held = swayed[project.ID] || []

    if (schedule && !held.length) {
      const { start, finish: days } = schedule[project.ID]

      return { rate, finish: days === null ? idle(finishRule, project.Queue > 0 ? 'a start (nothing ahead of it frees the share it needs)' : stalled(project), rate.inputs.present) : dated(rate, days), start }
    } else if (!isAvailable(capacity)) {
      return { rate, finish: { result: unavailable({ rule: finishRule, missing: capacity.inputs.missing, present: capacity.inputs.present }), idle: false }, start: null }
    }

    const own = gaps(project)

    if (project.Queue > 0 || own.length) {
      const missing = own.length ? own : [...groupGaps.map((text) => `${text} (another project of the colony and category)`), ...held]

      return { rate, finish: { result: unavailable({ rule: finishRule, missing, present: capacity.inputs.present }), idle: false }, start: null }
    }

    const { finish: days } = industrySchedule([project], capacity.value)[project.ID]

    return { rate, finish: days === null ? idle(finishRule, stalled(project), rate.inputs.present) : dated(rate, days), start: 0 }
  })
}

const FORECAST_STALLS = {
  queue: 'a start (nothing ahead of it frees the share it needs)',
  paused: 'a job that is making progress (it is paused)',
  rounding: 'a build above 0 in a cycle (what its share of the capacity buys in a cycle rounds to 0 at 4 decimals)',
  capacity: 'a rate above 0 (no capacity or share to work with)',
  cost: 'a build point cost above 0 a unit',
  remainder: 'a whole build (what is left of the project, or what it overshot, is a part of a unit finer than a build of 4 decimals, left by a fuel or installation limit, so no build can finish it exactly and what the game does with it is not known)',
  unresolved: 'a start (the project ahead of it cannot finish exactly, so whether the game ever frees its share is not known)',
}

// The resource of a cut or a stall as { mineralId, name }: a mineral, the fuel (no mineral id) or the source installations of a conversion (none either).
const resourceOf = (resource) => {
  const mineral = MINERALS.find((candidate) => candidate.name === resource)

  return mineral ? { mineralId: mineral.id, name: mineral.name } : { mineralId: null, name: resource === FUEL ? 'fuel' : 'source installations' }
}

// What the save leaves out of one colony's industrial projects that the cycle forecast needs, as a list of texts; empty when the forecast can run.
const forecastGaps = (projects, capacities, modifiers, npr) => {
  const gaps = new Set()
  const add = (text) => gaps.add(text)

  if (npr) {
    add('the stock of the capital, which a spied empire\'s colony builds from')
  }

  modifierGaps(modifiers, ['MinConstructionPeriod']).forEach(add)

  if (isNumber(modifiers && modifiers.MinConstructionPeriod) && !(modifiers.MinConstructionPeriod > 0)) {
    add('a construction period above 0')
  }

  projects.forEach((project) => {
    const category = categoryOf(project.ProductionType)

    if (category === 'unknown') {
      add('the production type of a project')
    } else if (!isAvailable(capacities[category])) {
      ;(capacities[category] ? capacities[category].inputs.missing : ['the colony\'s capacity']).forEach(add)
    }

    Object.keys(SCHEDULE_FIELDS).filter((key) => !isNumber(project[key])).forEach((key) => add(SCHEDULE_FIELDS[key]))

    if (!isNumber(project.PartialCompletion)) {
      add('the part of a unit a project has built')
    }

    MINERALS.forEach((mineral) => {
      if (!isNumber(project[mineral.name])) {
        add(`the ${mineral.name} a project needs`)
      } else if (project[mineral.name] > 0 && !isNumber(project[`Stock${mineral.name}`])) {
        add(`the colony's stock of ${mineral.name}`)
      }
    })

    if (!isNumber(project.FuelRequired)) {
      add('the fuel a project needs')
    } else if (project.FuelRequired > 0 && !isNumber(project.StockFuel)) {
      add('the colony\'s fuel stock')
    }

    if (isNumber(project.ConversionFrom) && !isNumber(project.ConversionSource)) {
      add('the installations a conversion project draws on')
    }
  })

  return [...gaps]
}

// What one colony's industrial projects need for the production cycle engine (`utilities/industry-cycle.js`) to forecast them together on the stock they share, with the same figures `industryFigures` gives. `projects`: the page's rows, each with the stock of its colony as `Stock<Mineral>` and `StockFuel`, `PartialCompletion` and, for a conversion, `ConversionFrom` (the installation type it consumes) and `ConversionSource` (how many the colony holds); `capacities`: { construction, ordnance, fighter } 'production.populationCapacity' results; `modifiers`: the colony's production modifiers row (its construction period is the length of a cycle); `arrivals`: the hypothetical arrivals of this colony, [{ resource (a mineral's name or 'fuel'), day, quantity, source }], none in any save; `npr`: a spied empire, whose projects build from its capital's stock. Returns { gaps } when the save lacks an input, otherwise the colony ready to run: { projects, capacities, cycleDays, entered, input } where `input` is the plain, serialisable argument of the engine.
export const prepareForecast = ({ projects, capacities, modifiers, arrivals = [], npr = false }) => {
  const gaps = forecastGaps(projects, capacities, modifiers, npr)

  if (gaps.length) {
    return { gaps }
  }

  const cycleDays = modifiers.MinConstructionPeriod / SECONDS_PER_DAY
  const stock = Object.fromEntries(MINERALS.map((mineral) => [mineral.name, isNumber(projects[0][`Stock${mineral.name}`]) ? projects[0][`Stock${mineral.name}`] : 0]))

  stock[FUEL] = isNumber(projects[0].StockFuel) ? projects[0].StockFuel : 0

  const sourceKey = (project) => `installation-${project.ConversionFrom}`

  projects.filter((project) => isNumber(project.ConversionFrom)).forEach((project) => (stock[sourceKey(project)] = project.ConversionSource))

  const resources = new Set([...MINERALS.map((mineral) => mineral.name), FUEL])
  const entered = arrivals.filter((arrival) => resources.has(arrival.resource) && isNumber(arrival.day) && arrival.day >= 0 && isNumber(arrival.quantity) && arrival.quantity > 0)

  return {
    projects,
    capacities,
    cycleDays,
    entered,
    input: {
      projects: projects.map((project) => ({
        ID: project.ID,
        Percentage: project.Percentage,
        Amount: project.Amount,
        PartialCompletion: project.PartialCompletion,
        ProdPerUnit: project.ProdPerUnit,
        Queue: project.Queue,
        Paused: flagOf(project.Paused),
        category: categoryOf(project.ProductionType),
        needs: { ...Object.fromEntries(MINERALS.map((mineral) => [mineral.name, project[mineral.name]])), [FUEL]: project.FuelRequired },
        source: isNumber(project.ConversionFrom) ? sourceKey(project) : null,
      })),
      capacities: Object.fromEntries(['construction', 'ordnance', 'fighter'].map((category) => [category, isAvailable(capacities[category]) ? capacities[category].value : 0])),
      stock,
      arrivals: entered,
      cycleDays,
    },
  }
}

// The figures the page shows for each project of a prepared colony, from the engine's forecast of it, a generator that yields between one project and the next wherever the `pace` says the time is up.
function* forecastFigures({ projects, capacities, cycleDays, entered }, engine, pace) {
  const figures = []

  for (const [index, project] of projects.entries()) {
    if (index > 0 && pace.expired()) {
      yield
    }

    const figure = engine.projects[project.ID]
    const rate = projectRate(capacities[categoryOf(project.ProductionType)], project)
    const sampled = !engine.orders.exhaustive
    const range = figure.earliest !== null && (sampled || figure.dependent || figure.stallOrders === 'some') ? { earliest: figure.earliest, latest: figure.latest, sampled } : null
    const sensitive = figure.sensitive ? { units: figure.unitsPerCycle, error: figure.roundingError } : null
    const stalled = figure.outcome === 'stalls' && figure.stall.resource !== null
    const shortage = stalled && figure.stallOrders === 'all' ? { ...resourceOf(figure.stall.resource), covered: figure.builtRange[0], coveredMost: figure.builtRange[1], day: figure.cut ? figure.cut.day : null } : null
    const maybeShort = stalled && figure.stallOrders === 'some' ? { ...resourceOf(figure.stall.resource), covered: figure.builtRange[0], coveredMost: figure.builtRange[1], day: figure.cut ? figure.cut.day : null } : null
    const held = figure.cut && figure.finish !== null ? { ...resourceOf(figure.cut.resource), day: figure.cut.day } : null

    const assumptions = [
      `A production cycle is taken as the game's construction period (${cycleDays.toFixed(2)} days); cycles played over a longer increment end later`,
      ...(entered.length ? [`${entered.length === 1 ? 'An arrival' : `${entered.length} arrivals`} of stock entered by hand ${entered.length === 1 ? 'is' : 'are'} counted; nothing else arrives`] : ['No minerals arrive: the colony\'s stock is all there is']),
      ...(range ? [engine.orders.exhaustive ? `The order the game takes the colony's projects in each cycle is not saved: ${engine.orders.tried} orders tried (every order), the project finishes ${range.latest === null ? 'in some of them and never in others' : 'between the earliest and the latest of them'}` : `The order the game takes the colony's projects in each cycle is not saved and too many projects compete for the stock to try every order: ${engine.orders.tried} orders were sampled, so the date is the earliest of those, not a bound, and another order may finish this project earlier or later`] : []),
      ...(sensitive ? [`A cycle builds only ${sensitive.units.toFixed(5)} of a unit and the game rounds a build to 4 decimals, up to ${(sensitive.error * 100).toFixed(0)}% of it, so a small error in the capacity or the cycle length moves this date by a large share of itself`] : []),
      'The game\'s arithmetic is reproduced exactly (decimals of 28 digits, the build rounded to 4 decimals with a tie to the even digit, the figures of the save read to 15 digits); the one thing it takes from the app is the colony\'s capacity, worked out from its installations and modifiers rather than read from the game, so a build within the precision of that figure of a midpoint of the rounding could round the other way',
    ]

    const present = ['the units left and the points a unit takes', 'the colony\'s stock of each mineral and the fuel, shared by its projects', 'the share of the capacity each project holds']
    const days = figure.earliest

    const finish = days !== null ? { result: combine({ rule: 'production.industryFinish', parts: { rate }, compute: () => days, inputs: { present }, assumptions }), idle: false } : idle('production.industryFinish', figure.outcome === 'beyond' ? `a finish within ${Math.round(HORIZON_DAYS / DAYS_PER_YEAR)} years` : stalled ? (figure.stall.reason === 'source' ? 'source installations to convert (the colony holds none left)' : `${resourceOf(figure.stall.resource).name} in the colony's stock (what it holds is used up and no arrival is entered)`) : FORECAST_STALLS[figure.stall.reason], rate.inputs.present)

    const covers = shortage || maybeShort ? ofRule({ rule: 'production.stockCover', value: (shortage || maybeShort).covered, inputs: { present: ['the units left', 'the colony\'s stock, shared by its projects', 'the project\'s need a unit'] } }) : null
    const queued = project.Queue > 0
    const startRange = queued && figure.startEarliest !== null && (sampled || figure.startDepends) ? { earliest: figure.startEarliest, latest: figure.startLatest, sampled } : null

    figures.push({ rate, finish, start: queued ? figure.startEarliest : 0, startRange, shortage, maybeShort, held, covers, range, sampled: sampled ? engine.orders.tried : null, fineRemainder: figure.fineRemainder, sensitive, supplied: figure.finish === null && figure.suppliedFinish !== null && stalled ? figure.suppliedFinish : null, forecast: figure })
  }

  return { figures, orders: engine.orders, events: engine.events, cycleDays }
}

// A quantity beyond the game's decimal type is the colony's own gap: its forecast is not made, and says why.
const overflowGap = (error) => `a quantity of the colony is beyond what the game's decimal type holds (${error.message})`

// The forecast of a prepared colony as a generator for the sliced run: it yields wherever the `pace` says the time is up and returns what `industryForecast` returns, `{ gaps }` for a colony the save leaves a gap in or whose quantity the decimal type cannot hold.
export function* industryForecastSteps(prepared, pace) {
  if (prepared.gaps) {
    return prepared
  }

  let engine

  try {
    engine = yield * forecastColonySteps(prepared.input, pace)
  } catch (error) {
    if (!(error instanceof RangeError)) {
      throw error
    }

    return { gaps: [overflowGap(error)] }
  }

  return yield * forecastFigures(prepared, engine, pace)
}

// The same forecast run to its end at once.
export const industryForecast = (colony) => {
  const steps = industryForecastSteps(prepareForecast(colony), UNPACED)
  let step = steps.next()

  while (!step.done) {
    step = steps.next()
  }

  return step.value
}

// The counts of a run over `total` colonies, in the shape of the search runner's.
const runCounts = (total, done) => ({ total, evaluated: done, pruned: 0, unexplored: total - done, feasible: done, retained: done, prunedBy: {} })

// The forecasts of several colonies as the search of one run (`utilities/search-run.js`): each colony in turn, yielding wherever the `pace` says the time is up (the engine looks at it at the start of every cycle or stretch of cycles), and returning { counts, termination, forecasts: { [populationId]: what `industryForecast` returns } }. `colonies`: [{ populationId, prepared }], each `prepared` from `prepareForecast` without gaps.
export function* industryForecastRun(colonies, pace) {
  const forecasts = {}

  const state = (done) => ({ progress: colonies.length ? done / colonies.length : 1, counts: runCounts(colonies.length, done), snapshot: () => ({ counts: runCounts(colonies.length, done), forecasts: { ...forecasts } }) })

  for (const [index, colony] of colonies.entries()) {
    const steps = industryForecastSteps(colony.prepared, pace)
    let step = steps.next()

    while (!step.done) {
      yield state(index)
      step = steps.next()
    }

    forecasts[colony.populationId] = step.value
  }

  return { counts: runCounts(colonies.length, colonies.length), termination: TERMINATION.EXHAUSTED, forecasts }
}

// What an industrial project's stock can't cover, as { shortage, covers, unknown }: `shortage` the first mineral or fuel the colony's stock cannot cover (`projectShortages`: { mineralId, name, covered }) or null, `covers` its 'production.shortage' result (the units the stock covers), or an unavailable one when no shortage is found while some stock or need is not in the save, `unknown` the names of what is not in the save. A mineral the project has no recorded need of is unknown, not free.
export const shortageOf = (project) => {
  const unknown = []
  const known = { ...project }

  if (!isNumber(project.Amount)) {
    unknown.push('the units left')
  }

  MINERALS.forEach((mineral) => {
    if (!isNumber(project[mineral.name])) {
      unknown.push(`the ${mineral.name} the project needs`)
      known[mineral.name] = 0
    } else if (project[mineral.name] > 0 && !isNumber(project[`Stock${mineral.name}`])) {
      unknown.push(`the colony's stock of ${mineral.name}`)
      known[mineral.name] = 0
    }
  })

  if (!isNumber(project.FuelRequired)) {
    unknown.push('the fuel the project needs')
    known.FuelRequired = 0
  } else if (project.FuelRequired > 0 && !isNumber(project.StockFuel)) {
    unknown.push('the colony\'s fuel stock')
    known.FuelRequired = 0
  }

  const shortage = isNumber(project.Amount) ? projectShortages(known)[0] || null : null

  if (shortage) {
    return { shortage, covers: ofRule({ rule: 'production.shortage', value: shortage.covered, inputs: { present: ['the units left', 'the colony\'s stock', 'the project\'s need a unit'] } }), unknown }
  }

  return { shortage: null, covers: unknown.length ? unavailable({ rule: 'production.shortage', missing: unknown }) : null, unknown }
}

// A shipyard task's rate in BP a year: the colony's build rate times a factor for the class's size. `ship`: { Size, CommercialModifier }, null where the class or the yard is not in the save.
export const shipRate = (modifiers, ship) => {
  const rule = 'production.shipRate'
  const missing = [...modifierGaps(modifiers, ['ShipyardBuildRate']), ...(isNumber(ship.Size) ? [] : ['the class\'s size']), ...(isNumber(ship.CommercialModifier) ? [] : ['the shipyard\'s type'])]

  if (missing.length) {
    return unavailable({ rule, missing })
  }

  return ofRule({ rule, value: modifiers.ShipyardBuildRate * (1 + ((ship.Size * ship.CommercialModifier) / 100 - 1) / 2), inputs: { present: [MODIFIER_TEXT.ShipyardBuildRate, 'the class\'s size', 'the shipyard\'s type'] } })
}

// A shipyard activity's rate in BP a year at the yard's capacity (`capacity`, which the continual upgrade raises): the colony's build rate times a factor for the capacity. `shipyard`: { SYType }.
export const shipyardUpgradeRate = (modifiers, shipyard, capacity = shipyard.Capacity) => {
  const rule = 'production.shipyardUpgradeRate'
  const missing = [...modifierGaps(modifiers, ['ShipyardBuildRate']), ...(isNumber(capacity) ? [] : ['the yard\'s capacity']), ...(isNumber(shipyard.SYType) ? [] : ['the shipyard\'s type'])]

  if (missing.length) {
    return unavailable({ rule, missing })
  }

  const commercialModifier = shipyard.SYType === 1 ? 1 : 0.1

  return ofRule({ rule, value: (1 + (capacity * commercialModifier / 5000 - 1) / 2) * modifiers.ShipyardBuildRate, inputs: { present: [MODIFIER_TEXT.ShipyardBuildRate, 'the yard\'s capacity and type'] } })
}

// Days until a continual capacity upgrade reaches its target, as { result, idle } of 'production.shipyardContinual'; idle when the yard cannot grow (no build rate), which would never reach the target.
export const shipyardContinualDays = (modifiers, shipyard) => {
  const rule = 'production.shipyardContinual'
  const missing = [...modifierGaps(modifiers, ['ShipyardBuildRate', 'ShipyardOperations', 'MinConstructionPeriod']), ...['Capacity', 'CapacityTarget', 'Slipways', 'SYType'].filter((key) => !isNumber(shipyard[key])).map((key) => ({ Capacity: 'the yard\'s capacity', CapacityTarget: 'the capacity target', Slipways: 'the yard\'s slipways', SYType: 'the shipyard\'s type' }[key]))]

  if (missing.length) {
    return { result: unavailable({ rule, missing }), idle: false }
  }

  const roi = modifiers.MinConstructionPeriod / SECONDS_PER_YEAR
  const periodDays = modifiers.MinConstructionPeriod / SECONDS_PER_DAY

  let periods = 0
  let lastUpgrade = 0
  let newCapacity = shipyard.Capacity

  do {
    const wat = (120 * shipyard.Slipways) * modifiers.ShipyardOperations
    const step = shipyardUpgradeRate(modifiers, shipyard, newCapacity).value * roi

    lastUpgrade = step / wat * (shipyard.SYType === 1 ? 500 : 5000)

    if (!(lastUpgrade > 0) || !Number.isFinite(lastUpgrade)) {
      return idle(rule, 'a yard that can grow (its build rate gives no step)')
    }

    newCapacity += lastUpgrade
    periods += 1
  } while (newCapacity < shipyard.CapacityTarget)

  return { result: ofRule({ rule, value: periods * periodDays, inputs: { present: ['the yard\'s capacity, slipways and target', MODIFIER_TEXT.MinConstructionPeriod] } }), idle: false }
}

// A shipyard activity's finish as { result, idle }: a continual upgrade by its stepping rule (approximate), a retool shared among the yard's slipways, any other by the remaining points over the rate. `rate`: `shipyardUpgradeRate`'s result.
export const shipyardFinish = (modifiers, shipyard, rate) => {
  const paused = flagOf(shipyard.Paused)

  if (paused === null || paused) {
    return finishDays({ rule: 'production.shipyardUpgradeFinish', rate, remaining: shipyard.RemainingProduction, remainingName: 'the activity\'s remaining build points', paused })
  } else if (shipyard.UpgradeTaskType === 8) {
    return shipyardContinualDays(modifiers, shipyard)
  }

  return finishDays({ rule: 'production.shipyardUpgradeFinish', rate, remaining: shipyard.RemainingProduction, remainingName: 'the activity\'s remaining build points', divisor: shipyard.UpgradeTaskType === 7 ? shipyard.Slipways : 1 })
}

// A training task's rate in BP a year: the colony's training capacity (a result) times the task's share.
export const trainingRate = (capacity, training) => {
  const rule = 'production.trainingRate'

  if (!isNumber(training.TaskPercentage)) {
    return unavailable({ rule, missing: [...(capacity.inputs.missing || []), 'the task\'s share of the capacity'], present: capacity.inputs.present })
  }

  return combine({ rule, parts: { capacity }, compute: (values) => (values.capacity * training.TaskPercentage) / 100, inputs: { present: ['the task\'s share of the capacity'] } })
}

// How many construction cycles until adding or removing water vapour on a body with liquid water ends, as the game runs them: the terraformers change the gas each cycle and the job ends once it passes the target; vapour above the air's humidity then condenses into the oceans, up to 0.1 atm a year, and the oceans evaporate up to it. `step`: atm the terraformers move a cycle; `years`: a cycle's length. Null when that takes more than WATER_VAPOUR_HORIZON years.
export const waterVapourCycles = (terraform, step, years) => {
  let gas = terraform.GasAtm || 0
  let pressure = terraform.AtmosPress
  let hydro = terraform.HydroExt
  const cycles = Math.ceil(WATER_VAPOUR_HORIZON / years)

  for (let cycle = 1; cycle <= cycles; cycle++) {
    if (terraform.TerraformStatus) {
      gas += step
      pressure += step

      if (gas > terraform.MaxAtm) {
        return cycle
      }
    } else {
      const removed = Math.min(step, gas)

      gas -= removed
      pressure -= removed

      if (gas <= 0) {
        if (!(hydro > 0)) {
          return cycle
        }
      } else if (gas <= terraform.MaxAtm && terraform.MaxAtm > 0) {
        return cycle
      }
    }

    const humidity = pressure * (hydro / 100) * WATER_VAPOUR_IN_ATMOSPHERE

    if (gas > humidity) {
      const condensed = Math.min(years * CONDENSATION_PER_YEAR, gas - humidity)

      gas -= condensed
      pressure -= condensed
      hydro += condensed * CONDENSATION_TO_HYDRO_RATE
    }

    const target = pressure * (hydro / 100) * WATER_VAPOUR_IN_ATMOSPHERE

    if (hydro > 0 && target > gas) {
      hydro -= (target - gas) * CONDENSATION_TO_HYDRO_RATE
      pressure += target - gas
      gas = target
    }
  }

  return null
}

// A colony's terraforming rate in atm a year on its own body, as a 'production.terraformRate' result: the planetary terraformers at the colony's rate plus each orbital group at the race's rate times its naval admin bonus, times the game's terraforming speed, spread over the body's surface against the Earth's. `planetary`: { terraformers } or null where the colony has none; `orbital`: [{ terraformers, adminBonus }], `terraformers` null where a ship's crew or class crew is not in the save; `radius`: the body's radius in km.
export const terraformRate = (modifiers, { planetary = null, orbital = [], radius }) => {
  const rule = 'production.terraformRate'
  const missing = modifierGaps(modifiers, ['TerraformingSpeed', ...(planetary ? ['PopulationTerraformingRate'] : []), ...(orbital.length ? ['TerraformingRate'] : [])])

  if (planetary && !isNumber(planetary.terraformers)) {
    missing.push('the colony\'s terraforming installations')
  }

  if (orbital.some((group) => !isNumber(group.terraformers) || (!isNumber(group.adminBonus) && !group.adminGap))) {
    missing.push('a terraformer ship\'s crew or its class crew')
  }

  for (const group of orbital) {
    if (group.adminGap) {
      missing.push(group.adminGap)
    }
  }

  if (!isNumber(radius) || !(radius > 0)) {
    missing.push('the body\'s radius')
  }

  if (missing.length) {
    return unavailable({ rule, missing: [...new Set(missing)] })
  }

  const capacity = (planetary ? modifiers.PopulationTerraformingRate * planetary.terraformers : 0) + orbital.reduce((total, group) => total + modifiers.TerraformingRate * group.adminBonus * group.terraformers, 0)
  const localSurfaceArea = 4 * Math.PI * Math.pow(radius, 2)

  return ofRule({ rule, value: capacity * modifiers.TerraformingSpeed * (EARTH_SURFACE_AREA / localSurfaceArea), inputs: { present: [MODIFIER_TEXT.TerraformingSpeed, 'the terraformers and their crews', 'the body\'s radius'] } })
}

// A terraforming job's finish as { result, idle, note }: the pressure still to move over the local rate, or the construction cycles water vapour takes over liquid water. `note` says why a water vapour job has no date (not within WATER_VAPOUR_HORIZON years). `terraform`: the colony's row (TerraformStatus, MaxAtm, GasAtm, GasAtmUnknown, GasName, HydroID, HydroExt, AtmosPress); `GasAtmUnknown` is 1 where the body's atmosphere has a row for the gas whose pressure is null, 0 where the row is absent (the gas is not there: 0 atm).
export const terraformFinish = (modifiers, terraform, rate) => {
  const rule = 'production.terraformFinish'
  const waterOnSurface = terraform.GasName === 'Water Vapour' && terraform.HydroID === 3
  const status = flagOf(terraform.TerraformStatus)
  const gasUnknown = !isNumber(terraform.GasAtm) && terraform.GasAtmUnknown !== 0
  const missing = [...(status === null ? ['whether the colony adds or removes the gas'] : []), ...(isNumber(terraform.MaxAtm) ? [] : ['the target pressure']), ...(gasUnknown ? ['the pressure of the gas in the body\'s atmosphere'] : [])]

  if (waterOnSurface) {
    missing.push(...modifierGaps(modifiers, ['MinConstructionPeriod']), ...(isNumber(terraform.HydroExt) ? [] : ['the hydrographic extent']), ...(isNumber(terraform.AtmosPress) ? [] : ['the atmospheric pressure']))
  }

  if (!isAvailable(rate)) {
    return { result: combine({ rule, parts: { rate }, compute: () => 0 }), idle: false }
  } else if (!(rate.value > 0)) {
    return { ...idle(rule, 'a rate above 0 (no terraforming capacity)', rate.inputs.present), note: undefined }
  } else if (missing.length) {
    return { result: unavailable({ rule, missing: [...new Set(missing)], present: rate.inputs.present }), idle: false, note: undefined }
  }

  const assumptions = isNumber(terraform.GasAtm) ? [] : ['A gas not in the body\'s atmosphere counts as 0 atm']
  const gas = isNumber(terraform.GasAtm) ? terraform.GasAtm : 0

  if (waterOnSurface) {
    const period = modifiers.MinConstructionPeriod

    if (!(period > 0)) {
      return { result: unavailable({ rule, missing: ['a construction period above 0'], present: rate.inputs.present }), idle: false, note: undefined }
    }

    const cycles = waterVapourCycles({ ...terraform, GasAtm: gas }, (rate.value * period) / SECONDS_PER_YEAR, period / SECONDS_PER_YEAR)

    if (cycles === null) {
      return { result: unavailable({ rule, missing: [`a finish within ${WATER_VAPOUR_HORIZON} years (the vapour condenses into the oceans)`], present: rate.inputs.present }), idle: true, note: `Not within ${WATER_VAPOUR_HORIZON} years: the vapour condenses into the oceans` }
    }

    return { result: combine({ rule, parts: { rate }, compute: () => (cycles * period) / SECONDS_PER_DAY, inputs: { present: ['the pressure, hydrographic extent and target'] }, assumptions }), idle: false, note: undefined }
  }

  return { result: combine({ rule, parts: { rate }, compute: (values) => Math.max(0, status ? terraform.MaxAtm - gas : gas - terraform.MaxAtm) / (values.rate / DAYS_PER_YEAR), inputs: { present: ['the pressure and target'] }, assumptions }), idle: false, note: undefined }
}

// The jobs binned by the day they finish, over `years` in `bins` bins: { counts: { [id]: [per bin] }, later, total, binDays, skipped: { unknown, idle, done }, result }. A job is a row of the job table: { days (null for none), finishIdle (true when a null `days` is a job not progressing rather than a missing input), type (its bar), shortage (it goes in the short bar) }. A job finishing within no bin counts as `later`; one with no date is `skipped`, as `unknown` (an input is missing), `idle` (paused, no capacity, never starts) or `done` (0 days left). `ids`: the bars, 'short' is added.
export const completionBins = (jobs, { years, bins }, ids) => {
  const binDays = (years * DAYS_PER_YEAR) / bins
  const counts = Object.fromEntries([...ids, 'short'].map((id) => [id, new Array(bins).fill(0)]))
  const skipped = { unknown: 0, idle: 0, done: 0 }
  let later = 0
  let total = 0

  jobs.forEach((job) => {
    if (job.days === null || job.days === undefined) {
      skipped[job.finishIdle ? 'idle' : 'unknown'] += 1
    } else if (!(job.days > 0)) {
      skipped.done += 1
    } else {
      const bin = Math.floor(job.days / binDays)

      if (bin >= bins) {
        later += 1
      } else {
        counts[job.shortage ? 'short' : job.type][bin] += 1
        total += 1
      }
    }
  })

  const result = ofRule({ rule: 'production.timeline', value: total, inputs: { present: ['the finish times of the jobs shown'], missing: skipped.unknown ? [`${skipped.unknown} ${skipped.unknown === 1 ? 'job' : 'jobs'} with no finish time known`] : [] } })

  return { counts, later, total, binDays, skipped, result }
}

// A sort for a table whose figures may be unknown (null): an unavailable figure sorts after every number in either direction, never as 0. Sorts by each of `sortBy` in turn, a group column first when the table is grouped, as Vuetify's `custom-sort` calls it.
export const sortNullLast = (items, sortBy, sortDesc) => {
  if (!sortBy.length) {
    return items
  }

  const missing = (value) => value === null || value === undefined || Number.isNaN(value)

  return [...items].sort((a, b) => {
    for (let index = 0; index < sortBy.length; index++) {
      const x = a[sortBy[index]]
      const y = b[sortBy[index]]

      if (missing(x) || missing(y)) {
        if (missing(x) !== missing(y)) {
          return missing(x) ? 1 : -1
        }

        continue
      }

      const order = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y

      if (order) {
        return order * (sortDesc[index] ? -1 : 1)
      }
    }

    return 0
  })
}
