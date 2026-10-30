// The ways an armourless station class (a mining platform: a hull with orbital mining modules) is produced, side by side for one class and one quantity: built in a shipyard, one task for each platform, or built by a colony's industry as a Space station project, which takes a share of the colony's construction capacity and makes the finished class. Both draw on the same class recipe (the class's cost in build points and its minerals, the sum of its components'), so what differs is the rate, the occupied capacity, the queue and what the colony's stock credits. Every figure is a result of a registered rule (utilities/provenance.js) and a rate or a share the save does not give leaves the time unavailable and named, never a guess; no path is called the cheaper one outright, only the quicker of two figures the same colony gives. The arithmetic is pure and takes plain rows; the loader reads them from an opened save.

import { heldShare, requirements } from './component-calc'
import { MINERALS } from './minerals'
import { ofRule, registerRule, unavailable, valueOrNull } from './provenance'
import { refitRate, retoolCost, retoolTime, yardEligibility } from './refits'
import { yardWorkers } from './workforce-demand'

const VERSIONS = ['2.7.x']
const DAYS_PER_YEAR = 365
const EPSILON = 1e-9
// The share of a colony's construction capacity, as a percentage, that a project may take at most.
const WHOLE_CAPACITY = 100

registerRule({
  id: 'platformPaths.recipe',
  versions: VERSIONS,
  units: 'BP',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.Cost', 'FCT_ClassComponent.NumComponent', 'FCT_ShipDesignComponents.Cost and the mineral columns'],
  note: 'What one platform of a class costs: the class\'s stored cost in build points, which is the sum of its components\' costs times their counts in every class of a checked save, and its minerals, the sum of the components\' minerals times their counts, which a stored Space station project of an unchanged class repeats exactly. Both paths build the same class, so both start from this recipe; a project made before the class was changed keeps the older figures.',
  assumptions: ['The recipe is the class as it stands now, not as a stored project of it was made.'],
})

registerRule({
  id: 'platformPaths.stationClass',
  versions: VERSIONS,
  units: 'verdict',
  verification: 'estimated',
  structure: ['FCT_ShipClass.NoArmour, Obsolete', 'FCT_ClassComponent', 'FCT_ShipDesignComponents.Prototype'],
  note: 'Whether a colony\'s industry can build a class as a Space station project: the class is on the race\'s own list (the class read is scoped to the race, and a class copied or captured from another race is the race\'s own once copied), not obsolete, has no armour (the class\'s No Armour setting) and mounts no prototype component. Creating the project also needs one hull\'s alien components (components the race has not researched) in the colony\'s own stock, which it does not use up or credit. The game states no size limit, no hull type and no shipyard for it. Read from the game\'s rules and seen in the stock sample\'s stored Space station projects, all of armourless classes; a refused class is not tried in a played game.',
  assumptions: ['The component called a structural shell is part of an armourless class and is no armour.', 'A component with no research row of the race is not researched.'],
})

registerRule({
  id: 'platformPaths.spaceport',
  versions: VERSIONS,
  units: 'yes or no',
  verification: 'estimated',
  structure: ['FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.Name'],
  note: 'A colony offers Space station projects to the player only with a spaceport. The game\'s project list is filled that way; whether the project can be made without one by other means is not known, so a colony without one is shown as unable.',
  assumptions: ['The spaceport is the installation named Spaceport.'],
})

registerRule({
  id: 'platformPaths.yard',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['refit.yardEligibility', 'production.shipRate', 'refit.retool', 'FCT_PopComponent.Amount', 'FCT_Shipyard.Slipways, Capacity, SYType'],
  note: 'The days a shipyard takes to build the platforms: one task for each, each at the yard\'s full rate for the class (the colony\'s shipbuilding rate times a factor for the class\'s size), a task for each free slipway at a time, the tasks started in turn as slipways free. A task takes the colony\'s stored components of the class first, at most what the class mounts, which lowers its build points and minerals. A yard that needs a retool adds the retool\'s days first. The time of work already on the slipways is not known, so a yard with no free slipway has no time.',
  assumptions: ['The tasks start at once, one platform each, and the colony\'s rates do not change while they run.', 'The stored components credit the first tasks made and are used up in turn.', 'The retool\'s own mineral draw is not counted.'],
})

registerRule({
  id: 'platformPaths.industry',
  versions: VERSIONS,
  units: 'days',
  verification: 'estimated',
  structure: ['production.populationCapacity', 'FCT_IndustrialProjects.Queue, Percentage, ProductionType', 'platformPaths.stationClass', 'platformPaths.spaceport'],
  note: 'The days a colony\'s industry takes to build the platforms as one Space station project: the platforms\' build points over the construction capacity at the share the colony\'s projects out of the queue (running or paused) leave free. The project takes no stored components and no shipyard slipway; its minerals are charged as it progresses and each platform is made when its share is complete. Capacity uses the colony\'s production modifiers, which the save may not hold.',
  assumptions: ['The project takes the whole free share from the start and the shares and rates do not change while it runs.', 'The colony\'s minerals are not held up by its other projects.'],
})

registerRule({
  id: 'platformPaths.labour',
  versions: VERSIONS,
  units: 'M workers',
  verification: 'confirmed',
  structure: ['FCT_Shipyard.Slipways, Capacity, SYType', 'FCT_PopulationInstallations.Amount', 'DIM_PlanetaryInstallation.Workers, ConstructionValue'],
  note: 'The workers the capacity a path draws on already holds, in millions: a yard\'s slipways times its capacity, a quarter-thousandth of a worker per ton at a naval yard and a tenth of that at a commercial or repair yard, and a colony\'s construction factories times the workers each needs. They are held whether or not the capacity is building, so a platform adds none; a colony short of workers lowers the output of both paths through its efficiency.',
})

// What a class is as a station: { state ('capable' or 'ineligible' or 'unknown'), blockers, missing }. `shipClass`: a class record of utilities/refits.js (obsolete, prototype); `noArmour`: true, false or null when the save has no such setting. The class list is already the race's own, so where a class came from (`otherRace`) decides nothing here.
export const stationEligibility = (shipClass, noArmour) => {
  const blockers = []
  const missing = []
  const flag = (value, blocker, gap) => {
    if (value === true) {
      blockers.push(blocker)
    } else if (value === null || value === undefined) {
      missing.push(gap)
    }
  }

  flag(noArmour === true ? false : noArmour === false ? true : null, 'the class carries armour, and a station project lists only classes without it', 'whether the class has armour')
  flag(shipClass.obsolete === undefined ? null : shipClass.obsolete, 'the class is obsolete', 'whether the class is obsolete')
  flag(shipClass.prototype, 'the class mounts a prototype component', 'whether the class mounts a prototype component')

  return { state: blockers.length ? 'ineligible' : missing.length ? 'unknown' : 'capable', blockers, missing }
}

// What a colony's stock must hold before a class can be made there, for `hulls` hulls: components the race has not researched (alien ones) must be in the colony's own stock, whatever the way of making. `researched`: { [componentId]: 1, 0 or null } as loadPlatformSources reads it, null when not read; `stock`: { [componentId]: units held } or null when the save has no stock table. Returns { blockers, missing }.
const admissionOf = ({ shipClass, components, researched, stock, hulls, wording }) => {
  const blockers = []
  const missing = []

  Object.entries(shipClass.counts).forEach(([id, count]) => {
    const state = researched ? researched[id] : null
    const name = (components[id] && components[id].name) || `component #${id}`

    if (state === 1) {
      return
    }

    if (state !== 0) {
      missing.push(`whether the race has researched ${name}`)

      return
    }

    const needed = count * hulls
    const held = stock === null || stock === undefined ? null : id in stock ? stock[id] : 0

    if (!Number.isFinite(count)) {
      missing.push(`how many ${name} the class mounts`)
    } else if (!Number.isFinite(held)) {
      missing.push(`the colony's stock of ${name}, which the race has not researched`)
    } else if (held < needed) {
      blockers.push(wording(name, held, needed))
    }
  })

  return { blockers, missing }
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

// The most platforms one comparison takes: each hull is a task of its own at every eligible yard, so the work grows with the number asked.
export const MAX_PLATFORMS = 1000

// The components a class mounts as the rows `requirements` takes. The research and prototype flags only decide what a component project could build, which no figure here uses, so they carry neutral values.
const partsOf = (shipClass, components) => Object.entries(shipClass.counts).map(([id, count]) => {
  const component = components[id] || { name: null, typeId: null, cost: null, minerals: {} }

  return { componentId: Number(id), name: component.name || `component #${id}`, typeId: component.typeId, count, cost: component.cost, minerals: component.minerals, prototype: 0, shippingLine: 0, researched: 1, obsolete: 0 }
})

// What one platform of the class is: { bp (the class's stored cost), minerals ({ [mineral]: tonnes } or null), missing }, as a 'platformPaths.recipe' result in `result`.
export const recipeOf = (shipClass, components) => {
  const missing = []
  const parts = partsOf(shipClass, components)

  if (!isNumber(shipClass.cost)) {
    missing.push('the class\'s cost')
  }

  parts.forEach((part) => {
    if (!isNumber(part.count)) {
      missing.push(`how many ${part.name} the class mounts`)
    }

    MINERALS.forEach(({ name }) => {
      if (!isNumber(part.minerals[name])) {
        missing.push(`the ${name} of ${part.name}`)
      }
    })
  })

  const gaps = [...new Set(missing)]
  const minerals = gaps.some((text) => !text.startsWith('the class')) ? null : Object.fromEntries(MINERALS.map(({ name }) => [name, parts.reduce((total, part) => total + part.count * part.minerals[name], 0)]))
  const rule = 'platformPaths.recipe'

  return {
    bp: isNumber(shipClass.cost) ? shipClass.cost : null,
    minerals,
    missing: gaps,
    result: gaps.length ? unavailable({ rule, missing: gaps, units: 'BP' }) : ofRule({ rule, value: shipClass.cost, inputs: { present: ['the class\'s cost', 'the components\' counts and minerals'] }, units: 'BP' }),
  }
}

const mineralsOf = (recipe, quantity, credit) => (recipe.minerals === null || credit === null ? null : Object.fromEntries(MINERALS.map(({ name }) => [name, Math.max(0, recipe.minerals[name] * quantity - credit.minerals[name])])))

// The minerals a path needs that the colony's stock does not hold: { [mineral]: tonnes short } for the minerals short, null where the need or the stock is not known.
const shortOf = (needed, stock) => {
  if (needed === null) {
    return null
  }

  const short = {}

  for (const { name } of MINERALS) {
    if (!stock || !isNumber(stock[name])) {
      return null
    }

    if (needed[name] - stock[name] > EPSILON) {
      short[name] = needed[name] - stock[name]
    }
  }

  return short
}

// The build points and minerals the colony's stored components take off each task, tasks made in turn: [{ bp, minerals }] for `quantity` tasks, the stock debited by each, and the total taken. A component the colony holds an unknown amount of makes the credit unknown (null).
const tasksOf = ({ shipClass, components, recipe, quantity, stock }) => {
  const parts = partsOf(shipClass, components)
  const total = stock === null ? null : requirements({ parts, hulls: quantity, stock })

  if (total === null || total.invalid || total.unknown || recipe.minerals === null || !isNumber(recipe.bp)) {
    return null
  }

  const left = Object.fromEntries(total.rows.map((row) => [row.componentId, row.held]))
  const tasks = []

  for (let task = 0; task < quantity; task++) {
    let bp = recipe.bp
    const minerals = { ...recipe.minerals }

    parts.forEach((part) => {
      const used = Math.min(left[part.componentId], part.count)

      left[part.componentId] -= used
      bp -= part.cost * used
      MINERALS.forEach(({ name }) => {
        minerals[name] -= part.minerals[name] * used
      })
    })

    tasks.push({ bp, minerals })
  }

  const minerals = Object.fromEntries(MINERALS.map(({ name }) => [name, parts.reduce((sum, part) => sum + part.minerals[name] * total.rows.find((row) => row.componentId === part.componentId).used, 0)]))

  return { tasks, credit: { bp: total.stockBP, minerals } }
}

// The finish, in years, of `tasks` (each a duration in years) started in turn on `slipways` slipways, each on the slipway that frees first, and the first one's finish.
const makespan = (durations, slipways) => {
  const free = new Array(Math.max(1, Math.min(slipways, durations.length))).fill(0)
  let first = Infinity

  durations.forEach((years) => {
    const slot = free.indexOf(Math.min(...free))

    free[slot] += years
    first = Math.min(first, free[slot])
  })

  return { finish: Math.max(...free), first }
}

const labourOf = (millions, text) => ({ millions, text, result: isNumber(millions) ? ofRule({ rule: 'platformPaths.labour', value: millions, inputs: { present: [text] }, units: 'M workers' }) : unavailable({ rule: 'platformPaths.labour', missing: [text], units: 'M workers' }) })

const daysResult = (rule, days, present, missing) => (missing.length ? unavailable({ rule, missing, units: 'days' }) : ofRule({ rule, value: days, inputs: { present }, units: 'days' }))

const empty = (base, state, extra = {}) => ({ ...base, state, bp: null, minerals: null, short: null, days: null, firstDays: null, retoolDays: null, startsLater: false, ...extra })

// One shipyard as a path for `quantity` platforms: { path: 'yard', state (a state of `yardEligibility`, or 'stalled' where a task could never finish: its build points are 0 after the stored components, or the colony's shipbuilding output is 0), reasons, missing, notes, bp (the tasks' build points after the stored components, null where the state gives none), minerals, short, days, firstDays, retoolDays, startsLater (a yard with no free slipway), credit, labour, timeResult }. `yard`: a row of loadYards; `colony`: { name, modifiers, stock, minerals }; `researched`: { [componentId]: 1, 0 or null } of loadPlatformSources.
export const yardPath = ({ shipClass, components, researched = null, recipe, quantity, yard, colony, context, version = null }) => {
  const rule = 'platformPaths.yard'
  const eligibility = yardEligibility(yard, shipClass, 'build', context)
  const planetary = yard.shipBased === false && isNumber(yard.type) && isNumber(yard.capacity) && isNumber(yard.slipways)
  const labour = yard.shipBased === true ? labourOf(0, 'a yard that belongs to a ship, which holds no colony workers') : labourOf(planetary ? yardWorkers(yard.type, yard.capacity, yard.slipways) : null, yard.shipBased === false ? 'the yard\'s type, capacity and slipways' : 'whether the yard belongs to a ship, and its type, capacity and slipways')
  const base = { path: 'yard', key: `yard-${yard.id}`, state: eligibility.state, yardId: yard.id, where: yard.name, populationId: yard.populationId, colony: yard.colony, reasons: eligibility.reasons, missing: eligibility.missing, notes: eligibility.notes, slipways: eligibility.slipways, eligibility, labour, credit: null, timeResult: unavailable({ rule, missing: [eligibility.state === 'unknown' ? 'what decides whether the yard can build it' : `a yard that can build the class (${eligibility.state})`], units: 'days' }) }

  if (!['capable', 'busy', 'retool'].includes(eligibility.state)) {
    return empty(base, eligibility.state)
  }

  if (eligibility.state === 'retool' && yard.shipBased === true) {
    return empty({ ...base, reasons: [...base.reasons, 'the class needs a retool, and a yard that belongs to a ship cannot be retooled'] }, 'ineligible')
  }

  const admission = admissionOf({ shipClass, components, researched, stock: colony.stock, hulls: quantity, wording: (name, held, needed) => `the race has not researched ${name}, and the colony holds ${held} of the ${needed} that ${quantity} platforms need: a shipyard task takes its alien components from the colony's stock` })

  if (admission.blockers.length) {
    return empty({ ...base, reasons: [...base.reasons, ...admission.blockers] }, 'ineligible')
  }

  if (admission.missing.length) {
    return empty({ ...base, missing: [...base.missing, ...admission.missing], timeResult: unavailable({ rule, missing: admission.missing, units: 'days' }) }, 'unknown')
  }

  if (eligibility.state === 'retool' && yard.shipBased !== false) {
    const gap = ['whether the yard belongs to a ship, which decides whether the retool the class needs is possible']

    return empty({ ...base, missing: [...base.missing, ...gap], timeResult: unavailable({ rule, missing: gap, units: 'days' }) }, 'unknown')
  }

  const sums = tasksOf({ shipClass, components, recipe, quantity, stock: colony.stock })
  const rate = refitRate(colony.modifiers, shipClass)
  const bp = sums ? sums.tasks.reduce((total, task) => total + task.bp, 0) : null
  const minerals = sums ? mineralsOf(recipe, quantity, sums.credit) : null
  const short = shortOf(minerals, colony.minerals)
  const detail = { ...base, bp, minerals, short, credit: sums ? sums.credit : null }
  const gaps = [...(sums ? [] : ['the class\'s recipe and the colony\'s component stock']), ...(valueOrNull(rate) === null ? ['the colony\'s shipbuilding rate for the class'] : [])]
  let retoolDays = 0

  if (eligibility.state === 'retool' && eligibility.tooling.kind === 'retool') {
    const operations = colony.modifiers && isNumber(colony.modifiers.ShipyardOperations) ? colony.modifiers.ShipyardOperations : null
    const priced = retoolCost({ tooling: eligibility.tooling.tooled, target: shipClass, refit: eligibility.tooling.refit, slipways: yard.slipways, operations, version })

    if (priced.kind === 'immediate') {
      retoolDays = 0
    } else {
      const days = valueOrNull(retoolTime(colony.modifiers, yard, priced.cost))

      if (days === null) {
        gaps.push('the days the yard\'s retool takes')
      } else {
        retoolDays = days
      }
    }
  }

  if (eligibility.state === 'busy') {
    return { ...detail, state: 'busy', days: null, firstDays: null, retoolDays: null, startsLater: true, timeResult: unavailable({ rule, missing: ['when a slipway is free: the time left on the work now on the slipways is not counted'], units: 'days' }) }
  }

  const free = eligibility.slipways.free

  if (!isNumber(free)) {
    gaps.push('the yard\'s free slipways')
  }

  if (gaps.length) {
    return { ...detail, days: null, firstDays: null, retoolDays: null, startsLater: false, timeResult: unavailable({ rule, missing: gaps, units: 'days' }) }
  }

  if (free <= 0) {
    return { ...detail, state: 'busy', reasons: [...detail.reasons, 'every slipway is working, and the yard needs a retool first'], days: null, firstDays: null, retoolDays: null, startsLater: true, timeResult: unavailable({ rule, missing: ['when a slipway is free: the time left on the work now on the slipways is not counted'], units: 'days' }) }
  }

  const perYear = valueOrNull(rate)

  if (!(perYear > 0)) {
    return { ...detail, state: 'stalled', reasons: [...detail.reasons, 'the colony\'s shipbuilding output for the class is 0, so no task makes progress'], days: null, firstDays: null, retoolDays: null, startsLater: false, timeResult: unavailable({ rule, missing: ['a shipbuilding rate above 0: the colony\'s output is 0'], units: 'days' }) }
  }

  if (sums.tasks.some((task) => task.bp <= EPSILON)) {
    return { ...detail, state: 'stalled', reasons: [...detail.reasons, 'a task whose build points the stored components cover wholly stays active in the game and never completes (the game divides by its build points), and it ends the colony\'s task processing'], days: null, firstDays: null, retoolDays: null, startsLater: false, timeResult: unavailable({ rule, missing: ['a completion time: a task with 0 build points left does not finish'], units: 'days' }) }
  }

  const { finish, first } = makespan(sums.tasks.map((task) => task.bp / perYear), free)
  const days = retoolDays + finish * DAYS_PER_YEAR

  return { ...detail, days, firstDays: retoolDays + first * DAYS_PER_YEAR, retoolDays, startsLater: false, timeResult: daysResult(rule, days, ['the colony\'s shipbuilding rate', 'the yard\'s free slipways', 'the class recipe', 'the colony\'s stored components'], []) }
}

// One colony's industry as a path for `quantity` platforms, a Space station project: { path: 'industry', state ('capable', 'busy' when the colony's projects hold the whole capacity, 'ineligible' or 'unknown'), reasons, missing, notes, bp, minerals, short, days, firstDays, share (the share taken, %), capacity (BP a year at the whole share), labour, timeResult }. `colony`: { populationId, name, capacity (a 'production.populationCapacity' result), projects, spaceports (a number, null when not read), factories ({ workers } in millions, null when not read), minerals }.
export const industryPath = ({ shipClass, components, researched = null, recipe, quantity, colony, station }) => {
  const rule = 'platformPaths.industry'
  const labour = labourOf(colony.factories && isNumber(colony.factories.workers) ? colony.factories.workers : null, 'the colony\'s construction factories and their workers')
  const base = { path: 'industry', key: `industry-${colony.populationId}`, yardId: null, where: 'Construction factories', populationId: colony.populationId, colony: colony.name, reasons: [], missing: [], notes: ['Takes no stored components and no shipyard slipway.'], labour, credit: null, share: null, capacity: null, timeResult: unavailable({ rule, missing: ['a colony that can make the class'], units: 'days' }) }
  const blockers = [...station.blockers]
  const missing = [...station.missing]
  const admission = admissionOf({ shipClass, components, researched, stock: colony.stock, hulls: 1, wording: (name, held, needed) => `the race has not researched ${name}, and the colony holds ${held} of the ${needed} that one hull needs: a station project checks the colony's stock for one hull and neither uses it up nor credits it` })

  blockers.push(...admission.blockers)
  missing.push(...admission.missing)

  if (colony.spaceports === 0) {
    blockers.push('the colony has no spaceport, which the project list needs')
  } else if (!isNumber(colony.spaceports)) {
    missing.push('whether the colony has a spaceport')
  }

  if (blockers.length) {
    return empty({ ...base, reasons: blockers }, 'ineligible')
  }

  const capacity = valueOrNull(colony.capacity)
  const held = colony.projects === null ? { held: 0, missing: ['the colony\'s industrial projects'] } : heldShare(colony.projects)
  const gaps = [...missing, ...(capacity === null ? ['the colony\'s construction capacity'] : []), ...held.missing, ...(isNumber(recipe.bp) && recipe.bp > 0 ? [] : ['the class\'s cost, above 0'])]
  const free = WHOLE_CAPACITY - held.held
  const minerals = recipe.minerals === null ? null : Object.fromEntries(MINERALS.map(({ name }) => [name, recipe.minerals[name] * quantity]))
  const detail = { ...base, bp: isNumber(recipe.bp) ? recipe.bp * quantity : null, minerals, short: shortOf(minerals, colony.minerals), capacity }

  if (gaps.length) {
    return { ...detail, state: 'unknown', reasons: [], missing: gaps, days: null, firstDays: null, retoolDays: null, startsLater: false, timeResult: unavailable({ rule, missing: gaps, units: 'days' }) }
  }

  if (free <= EPSILON) {
    return { ...detail, state: 'busy', reasons: [`the colony's projects out of the queue hold the whole construction capacity (${held.held}%), so a new project is queued`], days: null, firstDays: null, retoolDays: null, startsLater: true, share: 0, timeResult: unavailable({ rule, missing: ['a free share of the construction capacity: the time until one frees is not counted'], units: 'days' }) }
  }

  const perYear = capacity * (free / WHOLE_CAPACITY)

  if (!(perYear > 0)) {
    return { ...detail, state: 'ineligible', reasons: ['the colony has no construction capacity to take a share of'], days: null, firstDays: null, retoolDays: null, startsLater: false, share: free, timeResult: unavailable({ rule, missing: ['a construction capacity above 0'], units: 'days' }) }
  }

  const days = (detail.bp / perYear) * DAYS_PER_YEAR

  return { ...detail, state: 'capable', days, firstDays: (recipe.bp / perYear) * DAYS_PER_YEAR, retoolDays: null, startsLater: false, share: free, timeResult: daysResult(rule, days, ['the colony\'s construction capacity', 'the share its projects leave free', 'the class recipe'], []) }
}

const hasShortfall = (short) => short !== null && Object.keys(short).length > 0

// Every path for `quantity` platforms of `shipClass`, and what each colony gives of both: { recipe, station, rows (a row for every yard, for every colony with a spaceport, construction factories or installations not known, and for every colony with a yard), comparison (a row for every colony with both: `yards` every yard row of the colony, `yard` the quickest timed one, `industry`, `supply` 'covered' when both timed routes hold every mineral, 'short' when either lacks some, 'unknown' otherwise, `quicker` 'yard', 'industry', 'same' or null: a verdict only where both times are known and `supply` is 'covered', `rateQuicker` the same verdict on the rates alone, whatever the stock) }. `colonies`: { [populationId]: { name, modifiers, capacity, projects, stock (component stock), minerals, spaceports, factories, installationUnknown } }; `noArmour`: the class's No Armour setting; `researched`: { [componentId]: 1, 0 or null } of loadPlatformSources, null when not read.
export const comparePaths = ({ shipClass, noArmour, components, researched = null, quantity, yards, colonies, context, version = null }) => {
  const recipe = recipeOf(shipClass, components)
  const station = stationEligibility(shipClass, noArmour)

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PLATFORMS) {
    return { invalid: 'the number of platforms', recipe, station, rows: [], comparison: [] }
  }

  const colonyOf = (id) => colonies[id] || { name: null, modifiers: undefined, capacity: unavailable({ rule: 'platformPaths.industry', missing: ['the colony\'s production modifiers'], units: 'BP/yr' }), projects: null, stock: null, minerals: null, spaceports: null, factories: null }
  const yardRows = yards.map((yard) => yardPath({ shipClass, components, researched, recipe, quantity, yard, colony: colonyOf(yard.populationId), context, version }))
  const industryIds = [...new Set([...Object.keys(colonies).map(Number).filter((id) => colonies[id].spaceports > 0 || (colonies[id].factories && colonies[id].factories.workers > 0) || colonies[id].installationUnknown === true), ...yards.map((yard) => yard.populationId)])]
  const industryRows = industryIds.map((id) => industryPath({ shipClass, components, researched, recipe, quantity, colony: { ...colonyOf(id), populationId: id }, station }))
  const comparison = industryRows.flatMap((industry) => {
    const own = yardRows.filter((row) => row.populationId === industry.populationId)
    const timed = own.filter((row) => row.days !== null)
    const yard = timed.length ? timed.reduce((best, row) => (row.days < best.days ? row : best)) : null

    if (!own.length) {
      return []
    }

    const rateQuicker = yard === null || industry.days === null ? null : Math.abs(yard.days - industry.days) <= EPSILON ? 'same' : yard.days < industry.days ? 'yard' : 'industry'
    const supply = yard === null || industry.days === null ? 'unknown' : hasShortfall(yard.short) || hasShortfall(industry.short) ? 'short' : yard.short === null || industry.short === null ? 'unknown' : 'covered'

    return [{ populationId: industry.populationId, colony: industry.colony, yards: own, yard, industry, supply, quicker: supply === 'covered' ? rateQuicker : null, rateQuicker }]
  })

  return { invalid: null, recipe, station, rows: [...yardRows, ...industryRows], comparison }
}

const columnsOf = async (database, table) => {
  const [rows] = await database.query(`select name from pragma_table_info('${table}')`)

  return new Set(rows.map((row) => row.name))
}

// What the comparison reads beside the shipyards and the classes of utilities/refits.js: { extras ({ [ShipClassID]: { noArmour (true, false or null when the save has no such setting), miningModules } }), colonies ({ [PopulationID]: { stock ({ [ComponentID]: units held }), minerals, projects, spaceports (null when the save has no installation table or a spaceport's amount is not stored), factories ({ workers } in millions, null when it has none or an amount or worker figure is not stored), installationUnknown (an installation row of the colony lacks a stored figure) } }), researched ({ [ComponentID]: 1 for a component of the race's classes the race has researched, 0 for one it has not, null when the save cannot say }), stockRead }. A colony's component stock is a row only while it holds some, so no row is none held.
export const loadPlatformSources = async (database, { GameID, RaceID }) => {
  const [classColumns, projectColumns, installationColumns, definitionColumns, stockColumns, populationColumns] = await Promise.all(['FCT_ShipClass', 'FCT_IndustrialProjects', 'FCT_PopulationInstallations', 'DIM_PlanetaryInstallation', 'FCT_PopComponent', 'FCT_Population'].map((table) => columnsOf(database, table)))
  const replacements = { GameID, RaceID }
  const flag = (column) => (classColumns.has(column) ? `FCT_ShipClass.${column}` : `null as ${column}`)
  const [classes] = await database.query(`select FCT_ShipClass.ShipClassID, ${flag('NoArmour')}, ${flag('MiningModules')} from FCT_ShipClass where FCT_ShipClass.GameID = :GameID and FCT_ShipClass.RaceID = :RaceID`, { replacements })
  const minerals = MINERALS.map(({ name }) => (populationColumns.has(name) ? `FCT_Population.${name}` : `null as ${name}`)).join(', ')
  const [populations] = await database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, ${minerals} from FCT_Population where FCT_Population.GameID = :GameID and FCT_Population.RaceID = :RaceID`, { replacements })
  const [stock] = stockColumns.has('PopulationID') ? await database.query('select FCT_PopComponent.PopulationID, FCT_PopComponent.ComponentID, FCT_PopComponent.Amount from FCT_PopComponent inner join FCT_Population on FCT_Population.PopulationID = FCT_PopComponent.PopulationID where FCT_Population.GameID = :GameID and FCT_Population.RaceID = :RaceID', { replacements }) : [null]
  const [projects] = ['PopulationID', 'ProductionType', 'Queue', 'Percentage'].every((column) => projectColumns.has(column)) ? await database.query('select FCT_IndustrialProjects.PopulationID, FCT_IndustrialProjects.ProductionType, FCT_IndustrialProjects.Queue, FCT_IndustrialProjects.Percentage from FCT_IndustrialProjects where FCT_IndustrialProjects.GameID = :GameID and FCT_IndustrialProjects.RaceID = :RaceID', { replacements }) : [null]
  const installationsRead = ['PopID', 'PlanetaryInstallationID', 'Amount'].every((column) => installationColumns.has(column)) && ['PlanetaryInstallationID', 'Name', 'Workers', 'ConstructionValue'].every((column) => definitionColumns.has(column))
  const [installations] = installationsRead ? await database.query('select FCT_PopulationInstallations.PopID as PopulationID, sum(case when DIM_PlanetaryInstallation.Name = \'Spaceport\' then FCT_PopulationInstallations.Amount else 0 end) as Spaceports, sum(case when (DIM_PlanetaryInstallation.Name = \'Spaceport\' and FCT_PopulationInstallations.Amount is null) or (DIM_PlanetaryInstallation.Name is null and FCT_PopulationInstallations.Amount is not 0) then 1 else 0 end) as SpaceportUnknown, sum(case when DIM_PlanetaryInstallation.ConstructionValue > 0 then FCT_PopulationInstallations.Amount * DIM_PlanetaryInstallation.Workers else 0 end) as FactoryWorkers, sum(case when (DIM_PlanetaryInstallation.ConstructionValue > 0 and (FCT_PopulationInstallations.Amount is null or DIM_PlanetaryInstallation.Workers is null)) or (DIM_PlanetaryInstallation.ConstructionValue is null and FCT_PopulationInstallations.Amount is not 0) then 1 else 0 end) as FactoryUnknown from FCT_PopulationInstallations left join DIM_PlanetaryInstallation on DIM_PlanetaryInstallation.PlanetaryInstallationID = FCT_PopulationInstallations.PlanetaryInstallationID inner join FCT_Population on FCT_Population.PopulationID = FCT_PopulationInstallations.PopID where FCT_Population.GameID = :GameID and FCT_Population.RaceID = :RaceID group by FCT_PopulationInstallations.PopID', { replacements }) : [null]
  const techColumns = await columnsOf(database, 'FCT_RaceTech')
  const techKnown = techColumns.has('TechID') && techColumns.has('RaceID') ? (await database.query('select count(*) as TechRows from FCT_RaceTech where FCT_RaceTech.RaceID = :RaceID', { replacements }))[0][0].TechRows > 0 : false
  const [classComponents] = await database.query(`select FCT_ClassComponent.ComponentID, ${techKnown ? 'max(case when FCT_RaceTech.TechID is null then 0 else 1 end)' : 'null'} as Researched from FCT_ClassComponent inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ClassComponent.ClassID ${techKnown ? 'left join FCT_RaceTech on FCT_RaceTech.TechID = FCT_ClassComponent.ComponentID and FCT_RaceTech.RaceID = :RaceID' : ''} where FCT_ShipClass.GameID = :GameID and FCT_ShipClass.RaceID = :RaceID group by FCT_ClassComponent.ComponentID`, { replacements })
  const byColony = {}
  const entry = (id) => (byColony[id] = byColony[id] || { name: null, stock: stock === null ? null : {}, minerals: null, projects: projects === null ? null : [], spaceports: installations === null ? null : 0, factories: installations === null ? null : { workers: 0 }, installationUnknown: installations === null })

  populations.forEach((row) => {
    entry(row.PopulationID).name = row.PopName
    entry(row.PopulationID).minerals = Object.fromEntries(MINERALS.map(({ name }) => [name, isNumber(row[name]) ? row[name] : null]))
  })
  ;(stock || []).forEach((row) => {
    entry(row.PopulationID).stock[row.ComponentID] = isNumber(row.Amount) ? row.Amount : null
  })
  ;(projects || []).forEach((row) => {
    entry(row.PopulationID).projects.push(row)
  })
  ;(installations || []).forEach((row) => {
    const colony = entry(row.PopulationID)
    const spaceports = isNumber(row.Spaceports) ? row.Spaceports : 0

    colony.spaceports = spaceports > 0 ? spaceports : row.SpaceportUnknown > 0 || !isNumber(row.Spaceports) ? null : spaceports
    colony.factories = { workers: row.FactoryUnknown > 0 || !isNumber(row.FactoryWorkers) ? null : row.FactoryWorkers }
    colony.installationUnknown = row.SpaceportUnknown > 0 || row.FactoryUnknown > 0
  })

  return {
    extras: Object.fromEntries(classes.map((row) => [row.ShipClassID, { noArmour: row.NoArmour === 1 ? true : row.NoArmour === 0 ? false : null, miningModules: isNumber(row.MiningModules) ? row.MiningModules : null }])),
    colonies: byColony,
    researched: Object.fromEntries(classComponents.map((row) => [row.ComponentID, row.Researched === 1 ? 1 : row.Researched === 0 ? 0 : null])),
    stockRead: stock !== null,
  }
}
