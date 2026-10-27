// The reserves the player keeps at a source and what the player plans to take from it or add to it, as local records: a colony's own reserve of fuel, maintenance supplies and each mineral for one scenario, with the withdrawals and the refills planned against that stock and the day of each, and the fuel a ship or a ship class keeps aboard. The record is the player's own: it is not the game's reserve of a colony, not the minimum of a ship class, and nothing here gives the game an order or writes to the save.
//
// A record is a typed record of the scenario repository (utilities/scenario-records.js) of kind `resource.reserve`, kept in the campaign's scenario file for the race and by default for the branch only. Its payload is `{ source, scenario, reserves, plans, note }`: `source` is the colony, the ship or the ship class (a reference `{ type, id, name, systemId, systemName, origin, confirmed }`: what the player saw when the record was last kept, the campaign and branch the link was made on and the object as the player confirmed it), `scenario` the name the player gave the plan, `reserves` the amount kept by resource (0 is a reserve of nothing, an absent resource is none set) and `plans` the timed withdrawals and refills `{ id, label, resource, kind, amount, day }`. There is one record for a source and a scenario. A ship or a ship class keeps a fuel reserve alone and no timed lines: the ledger spends the stocks of colonies, and a ship's fuel is read by the fuel service (utilities/fuel-donors.js) as `fuelReserveOf`, a ship's own reserve over that of its class.
//
// A colony has no creation time in the save, so a record is held only by the player's confirmation of that very colony (its name, its system, its body and its species), as a fleet station's colony is (utilities/fleet-stations.js, `verdictOf`): an ID that is given to another colony reads as under review, the record applies to nothing until the player confirms it, and it is never moved to a colony of the same name. A ship is held by its construction time and, where the save lacks it, by the player's confirmation; a ship class, which the save dates nowhere, by the confirmation alone. A record made after the open save's game time is listed apart and applies to nothing until the player moves it to the save. Whether a link still holds is worked out on every read and never stored.
//
// Storage and the rules of a stale edit are the repository's. This module takes the repository as an argument, so a check runs it on in-memory stores.

import { noteChoices } from './economy-notes'
import { STATION_TARGETS, VERDICTS, verdictOf } from './fleet-stations'
import { LINK_TYPES, checkLink, failure, mayWrite, resolveLink } from './history-milestones'
import { PLAN_SCENARIO, RESOURCE_KEYS } from './resource-ledger'
import { registerRule } from './provenance'

export { scopeOf } from './history-milestones'
export { PLAN_SCENARIO, noteChoices }

export const RESERVE_KIND = 'resource.reserve'
export const RESERVE_SCHEMA = 1
export const SCENARIO_LENGTH = 60
export const LABEL_LENGTH = 80
export const NOTE_LENGTH = 200
export const PLANS_PER_RECORD = 40
export const MAX_DAY = 3650
export const FUEL_RESOURCE = 'fuel'

export const PLAN_KINDS = Object.freeze({ withdraw: 'Withdrawal', refill: 'Refill' })

const FUEL = FUEL_RESOURCE

const RESERVE_VERSIONS = ['2.7.x']

registerRule({
  id: 'reserveLedger.player',
  versions: RESERVE_VERSIONS,
  units: 'litres, supplies or tonnes',
  verification: 'confirmed',
  structure: ['the scenario records of kind resource.reserve'],
  note: 'The amount of a resource the player keeps back at a colony, read from the player\'s own record. It is not stored in the save and the game does not know it: a withdrawal planned here leaves it in the stock, and nothing stops a ship or a mass driver from taking it in the game. Zero is a reserve of nothing; a resource with no reserve set shows none, which the ledger treats as 0.',
})

registerRule({
  id: 'reserveLedger.gameMinimum',
  versions: RESERVE_VERSIONS,
  units: 't',
  verification: 'confirmed',
  structure: ['FCT_Population.Reserve<mineral>'],
  note: 'The reserve of a mineral the game stores for a colony: the stock the colony keeps back from its mass driver export, and the floor the Hauling plan leaves. A colony has no stored minimum of fuel or maintenance supplies, so none is shown for them, and WarningFuel and WarningMSP are warning levels, not reserves.',
})

registerRule({
  id: 'reserveLedger.classMinimum',
  versions: RESERVE_VERSIONS,
  units: 'litres or supplies',
  verification: 'confirmed',
  structure: ['FCT_ShipClass.MinimumFuel, MinimumSupplies of the classes that have ships'],
  note: 'The most fuel or supplies a ship of any class in service keeps back when it gives them to another ship: a stored figure of each ship class, read as it is. It applies to the ships of the class and not to a colony\'s stock, and no mineral has one.',
})

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isText = (value) => typeof value === 'string' && value.trim() !== ''

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const copyOf = (value) => JSON.parse(JSON.stringify(value))

const messageOf = (error) => (error && error.message ? error.message : String(error))

const COLONY = STATION_TARGETS.colony

const present = (value) => (value === null || value === undefined ? '' : String(value))

// The ships of the race, with the class each is of for the player to tell it by: a ship is held by its construction time, as the ship of a milestone is.
const SHIP = Object.freeze({
  ...LINK_TYPES.ship,
  sql: 'select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.Constructed, FCT_ShipClass.ClassName from FCT_Ship left join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID where FCT_Ship.GameID = :GameID and FCT_Ship.RaceID = :RaceID order by FCT_Ship.ShipID',
  row: (source) => ({ ...LINK_TYPES.ship.row(source), group: present(source.ClassName) }),
})

// The ship classes of the race. The save dates a class nowhere, so one is held by the player's confirmation alone; the fingerprint holds the hull, which a rename does not change.
const CLASS = Object.freeze({
  label: 'Ship class',
  identity: 'unwitnessed',
  unwitnessedNote: 'Not checked: the save stores no date for a ship class, and the ID of a deleted class can be given again to a new one, so nothing shows this is the class the record was made for',
  sql: 'select FCT_ShipClass.ShipClassID, FCT_ShipClass.ClassName, FCT_ShipClass.HullDescriptionID from FCT_ShipClass where FCT_ShipClass.GameID = :GameID and FCT_ShipClass.RaceID = :RaceID order by FCT_ShipClass.ShipClassID',
  row: (source) => ({ type: 'class', id: source.ShipClassID, name: present(source.ClassName), hullId: source.HullDescriptionID }),
  fingerprint: (row) => ['class', present(row.hullId)].join('|'),
})

// The kinds of object a record names, in the shape of the milestones' `LINK_TYPES`, which the link check reads: the colony a reserve is kept at, a ship and a ship class.
export const RESERVE_TARGETS = Object.freeze({ colony: COLONY, ship: SHIP, class: CLASS })

// What a kind of source is called in the words of a message: colony, ship, ship class.
const nounOf = (type) => RESERVE_TARGETS[type].label.toLowerCase()

// The race's objects of the kinds asked for in the open save, which a record's source is checked against and picked from: `{ objects: { [type]: Map(id -> row) }, GameID, RaceID }`. The colonies by default; a kind that is not asked for is not in `objects`, and the links to it read as not checked. A read that fails fails the whole read, so an object that was not read is never taken for one that is gone. Every read is a select.
export const loadReserveObjects = async (database, { GameID, RaceID }, { types = ['colony'] } = {}) => {
  const kinds = types.filter((type) => hasOwn(RESERVE_TARGETS, type))
  const maps = await Promise.all(kinds.map(async (type) => {
    const [rows] = await database.query(RESERVE_TARGETS[type].sql, { replacements: { GameID, RaceID } })

    return [type, new Map(rows.map((source) => RESERVE_TARGETS[type].row(source)).map((row) => [row.id, row]))]
  }))

  return Object.freeze({ objects: Object.freeze(Object.fromEntries(maps)), GameID, RaceID })
}

// ---- The record ------------------------------------------------------------------------------------------------------

const PAYLOAD_KEYS = ['source', 'scenario', 'reserves', 'plans', 'note']

const refOk = (ref) => isObject(ref) && hasOwn(RESERVE_TARGETS, ref.type) && (isText(ref.id) || isNumber(ref.id)) && typeof ref.name === 'string' && (ref.systemId === null || Number.isInteger(ref.systemId)) && typeof ref.systemName === 'string' && isObject(ref.origin) && isText(ref.origin.campaignId) && isText(ref.origin.branchId) && isObject(ref.confirmed) && typeof ref.confirmed.fingerprint === 'string' && typeof ref.confirmed.name === 'string' && ref.confirmed.classes === null && isNumber(ref.confirmed.gameTime)

const scenarioProblem = (scenario) => {
  if (typeof scenario !== 'string' || scenario.trim() === '' || scenario !== scenario.trim()) {
    return 'the scenario is a name with no space around it'
  }

  if (scenario.length > SCENARIO_LENGTH) {
    return `the scenario is at most ${SCENARIO_LENGTH} characters`
  }

  return scenario.toLowerCase() === PLAN_SCENARIO.toLowerCase() ? `the scenario cannot be named ${PLAN_SCENARIO}: the plan of that name is the Hauling Planner's own` : null
}

const planProblems = (plan, index) => {
  const at = `plan ${index + 1}`

  if (!isObject(plan) || Object.keys(plan).sort().join(',') !== 'amount,day,id,kind,label,resource') {
    return [`${at} is { id, label, resource, kind, amount, day }`]
  }

  return [
    ...(isText(plan.id) && plan.id.length <= 20 ? [] : [`${at} has an id of at most 20 characters`]),
    ...(typeof plan.label === 'string' && plan.label.trim() !== '' && plan.label === plan.label.trim() && plan.label.length <= LABEL_LENGTH ? [] : [`${at} has a label of 1 to ${LABEL_LENGTH} characters with no space around it`]),
    ...(RESOURCE_KEYS.includes(plan.resource) ? [] : [`${at} names a resource the ledger does not know`]),
    ...(hasOwn(PLAN_KINDS, plan.kind) ? [] : [`${at} is a withdrawal or a refill`]),
    ...(isNumber(plan.amount) && plan.amount > 0 ? [] : [`${at} has an amount above 0`]),
    ...(isNumber(plan.day) && plan.day >= 0 && plan.day <= MAX_DAY ? [] : [`${at} is on a day from 0 to ${MAX_DAY}`]),
  ]
}

// What is wrong with a record to be kept: a list of problems, empty when it is valid.
export const problemsOf = (payload) => {
  if (!isObject(payload)) {
    return ['the record is an object']
  }

  const problems = []
  const extra = Object.keys(payload).filter((key) => !PAYLOAD_KEYS.includes(key))

  if (extra.length || PAYLOAD_KEYS.some((key) => !hasOwn(payload, key))) {
    return [`the record is { ${PAYLOAD_KEYS.join(', ')} } and nothing else`]
  }

  if (!refOk(payload.source)) {
    problems.push('source is { type, id, name, systemId, systemName, origin, confirmed } of a colony, a ship or a ship class, origin being the campaign and branch it was made on and confirmed the object as it was confirmed')
  }

  const scenario = scenarioProblem(payload.scenario)

  if (scenario) {
    problems.push(scenario)
  }

  if (!isObject(payload.reserves)) {
    problems.push('reserves is an object of the amount kept by resource')
  } else {
    Object.entries(payload.reserves).forEach(([resource, amount]) => {
      if (!RESOURCE_KEYS.includes(resource)) {
        problems.push(`the reserve names ${resource}, which the ledger does not know`)
      } else if (!isNumber(amount) || amount < 0) {
        problems.push(`the reserve of ${resource} is a number, 0 or more`)
      }
    })
  }

  if (!Array.isArray(payload.plans) || payload.plans.length > PLANS_PER_RECORD) {
    problems.push(`plans is a list of at most ${PLANS_PER_RECORD}`)
  } else {
    payload.plans.forEach((plan, index) => problems.push(...planProblems(plan, index)))

    if (new Set(payload.plans.map((plan) => (isObject(plan) ? plan.id : null))).size !== payload.plans.length) {
      problems.push('the plans have one id each')
    }
  }

  if (typeof payload.note !== 'string' || payload.note.length > NOTE_LENGTH) {
    problems.push(`the note is at most ${NOTE_LENGTH} characters`)
  }

  if (refOk(payload.source) && payload.source.type !== 'colony') {
    const noun = nounOf(payload.source.type)
    const others = isObject(payload.reserves) ? Object.keys(payload.reserves).filter((resource) => resource !== FUEL) : []

    if (others.length) {
      problems.push(`a ${noun} keeps a fuel reserve alone, not ${others.join(', ')}`)
    }

    if (Array.isArray(payload.plans) && payload.plans.length) {
      problems.push(`a ${noun} has no timed lines`)
    }
  }

  return problems
}

// A link that is not read is told apart from one that is not there: the adapter answers with this when the objects of its kind were not given, and the repository takes the link as not known.
const UNREAD = Object.freeze({ unread: true })

// The adapter of the scenario repository for the reserve records. The link is resolved against `context.objects[type]`: an object that is not there is missing, and with no objects of its kind given the link is unknown.
export const reserveAdapter = Object.freeze({
  kind: RESERVE_KIND,
  schema: RESERVE_SCHEMA,
  validate: problemsOf,
  fingerprint: (type, row) => {
    if (!hasOwn(RESERVE_TARGETS, type)) {
      throw new Error(`${type} is not a kind of object a reserve record names`)
    }

    if (row === UNREAD) {
      throw new Error(`the ${nounOf(type)} objects of the save were not read`)
    }

    return RESERVE_TARGETS[type].fingerprint(row)
  },
  resolve: (links, context) => links.map((link) => {
    const objects = context && context.objects ? context.objects[link.type] : null

    return objects instanceof Map ? objects.get(link.id) || null : UNREAD
  }),
})

const registered = new WeakSet()

// Registers the adapter with a repository's `registerAdapter`, once per function.
export const registerResourceReserves = (register) => {
  if (registered.has(register)) {
    return
  }

  try {
    register(reserveAdapter)
  } catch (error) {
    if (!/registered already/.test(messageOf(error))) {
      throw error
    }
  }

  registered.add(register)
}

// ---- The records as the open save reads them -------------------------------------------------------------------------

const NOT_SHOWN = ['newer-schema', 'no-adapter', 'invalid-payload']

const PLURALS = Object.freeze({ colony: 'colonies', ship: 'ships', class: 'ship classes' })

// Why a record applies to nothing, in the words of the kind of source it names.
const whyOf = (type) => {
  const noun = nounOf(type)

  return {
    ahead: 'The record was made at a later game time than this save, so it applies to nothing until it is moved to the save.',
    review: `The ${noun} that holds this ID is not confirmed as the one the record was made for, so the record applies to nothing until it is confirmed.`,
    gone: `The ${noun} is no longer in the save, so the record applies to nothing.`,
    unread: `The ${PLURALS[type]} of the save could not be checked, so the record applies to nothing yet.`,
    overlap: `Another record keeps the same scenario for this ${noun} in this campaign (made on another branch, or brought in by an import), so neither applies until one of them is deleted or edited.`,
  }
}

const refusal = (error) => ({ code: error.code, message: error.message })

// The source of a record as the list shows it: what the player kept, the link checked against the open save and the verdict on it, the colony now under the ID (null when there is none) and the name it has now when it is the one named and was renamed.
const viewOf = (item, context) => {
  const ref = item.payload.source
  const stored = item.links[0]
  const link = resolveLink(stored, ref, context, RESERVE_TARGETS)
  const objects = context && context.objects ? context.objects[ref.type] : null
  const row = objects instanceof Map ? objects.get(stored.id) || null : null
  const verdict = verdictOf(ref, link, row, context, RESERVE_TARGETS)

  return { type: ref.type, id: ref.id, name: ref.name, nowNamed: verdict.state === VERDICTS.HELD && row && row.name !== ref.name ? row.name : null, systemId: ref.systemId, systemName: ref.systemName, origin: { campaignId: ref.origin.campaignId, branchId: ref.origin.branchId }, confirmed: copyOf(ref.confirmed), link, verdict, row: verdict.state === VERDICTS.HELD || verdict.state === VERDICTS.REVIEW ? row : null }
}

const entryOf = (item, context) => {
  if (item.links.length !== 1) {
    return null
  }

  const source = viewOf(item, context)
  const ahead = item.status === 'ahead'
  const state = source.verdict.state
  const applied = !ahead && state === VERDICTS.HELD
  const why = whyOf(source.type)

  return {
    uuid: item.record.uuid,
    revision: item.record.revision,
    policy: item.record.association.policy,
    otherBranch: item.flags.includes('other-branch'),
    madeAt: item.record.base.gameTime,
    ahead,
    flags: [...item.flags],
    scenario: item.payload.scenario,
    note: item.payload.note,
    source,
    reserves: copyOf(item.payload.reserves),
    plans: copyOf(item.payload.plans),
    applied,
    reason: applied ? '' : ahead ? why.ahead : state === VERDICTS.REVIEW ? why.review : state === VERDICTS.GONE ? why.gone : why.unread,
    links: item.links,
  }
}

const noteOf = (item, reason) => ({ uuid: item.record.uuid, flags: item.flags, reason: reason || `A record written by another version of the app or not valid is not listed (${item.flags.join(', ')}).` })

// The reserve records of the race in the campaign as the open branch reads them: `{ entries, notes, error }`. `context` is `{ objects, ... }` of the open save, or null while its colonies are not read: the links are then not read, which is neither held nor gone, and no record applies. A record the adapter does not understand is a note of the list's own (`notes`). Nothing is written.
export const readReserves = (repository, scope, context = null) => {
  const empty = { entries: [], notes: [], error: null }

  if (!repository || !scope) {
    return empty
  }

  let listed

  try {
    listed = repository.list(scope, { kind: RESERVE_KIND, context: context || undefined })
  } catch (error) {
    if (error && error.name === 'RecordsRefused') {
      return { ...empty, error: refusal(error) }
    }

    throw error
  }

  const unreadable = (item) => item.flags.some((flag) => NOT_SHOWN.includes(flag))
  const entries = []
  const notes = listed.filter(unreadable).map((item) => noteOf(item))

  listed.filter((item) => !unreadable(item)).forEach((item) => {
    const entry = entryOf(item, context)

    if (entry) {
      entries.push(entry)
    } else {
      notes.push(noteOf(item, 'A record whose link does not match what it names is not listed.'))
    }
  })

  const holders = new Map()

  entries.filter((entry) => entry.applied).forEach((entry) => {
    const key = `${entry.source.type}:${entry.source.id}:${entry.scenario}`

    holders.set(key, (holders.get(key) || 0) + 1)
  })

  entries.forEach((entry) => {
    entry.overlap = entry.applied ? holders.get(`${entry.source.type}:${entry.source.id}:${entry.scenario}`) - 1 : 0

    if (entry.overlap > 0) {
      entry.applied = false
      entry.reason = whyOf(entry.source.type).overlap
    }
  })

  return { entries: entries.sort((a, b) => a.scenario.localeCompare(b.scenario) || a.source.name.localeCompare(b.source.name) || (a.uuid < b.uuid ? -1 : 1)), notes, error: null }
}

// The records of colonies that apply to the open save, as the ledger takes them: a record made at or before the save's time whose colony is held by evidence or by the player's confirmation. A record under review, a record whose colony is gone and a record made after the save apply to nothing. A record of a ship or a ship class is not the ledger's: it keeps no stock of a colony, and its ID may be that of a colony.
export const entriesForLedger = (entries) => entries.filter((entry) => entry.applied && entry.source.type === 'colony').map((entry) => ({ uuid: entry.uuid, scenario: entry.scenario, sourceId: entry.source.id, reserves: entry.reserves, plans: entry.plans }))

// The fuel a colony, a ship or a ship class keeps, from the records that apply: `{ colony: Map(id -> { amount, scenarios }), ship: Map, class: Map }`. `scenarios` are the scenarios chosen (none chosen is all of them); of the records of one source in the scenarios chosen the largest amount holds, 0 being a reserve of nothing.
export const fuelReserves = (entries, scenarios = []) => {
  const table = { colony: new Map(), ship: new Map(), class: new Map() }

  entries.filter((entry) => entry.applied && hasOwn(table, entry.source.type) && hasOwn(entry.reserves, FUEL) && (!scenarios.length || scenarios.includes(entry.scenario))).forEach((entry) => {
    const kept = table[entry.source.type]
    const held = kept.get(entry.source.id)

    if (held) {
      held.amount = Math.max(held.amount, entry.reserves[FUEL])
      held.scenarios.push(entry.scenario)
    } else {
      kept.set(entry.source.id, { amount: entry.reserves[FUEL], scenarios: [entry.scenario] })
    }
  })

  return table
}

// The fuel reserve that holds for a ship (`ShipID`, `ShipClassID`): its own when it has one, even a smaller one than its class's, else its class's, else null. `source` says which.
export const fuelReserveOf = (table, ship) => {
  const own = table.ship.get(ship.ShipID)

  if (own) {
    return { amount: own.amount, source: 'ship', scenarios: [...own.scenarios] }
  }

  const kind = table.class.get(ship.ShipClassID)

  return kind ? { amount: kind.amount, source: 'class', scenarios: [...kind.scenarios] } : null
}

// The scenarios the records name, by name; the plan of the Hauling Planner is not one of them.
export const scenarioNames = (entries) => [...new Set(entries.map((entry) => entry.scenario))].sort((a, b) => a.localeCompare(b))

// ---- Writes ----------------------------------------------------------------------------------------------------------

const ASSUMPTION_OWN = 'The record is the player\'s own: it gives no order to the game and writes nothing to the save'

const assumptionsOf = (type) => [ASSUMPTION_OWN, `The ${nounOf(type)} it names stays the one the record was made for only while the player confirmed that very ${nounOf(type)}`]

const gameTimeOf = (scope) => (Number.isFinite(scope.gameTime) ? scope.gameTime : 0)

const refOf = (type, row, scope) => ({ type, id: row.id, name: row.name, systemId: row.systemId || null, systemName: row.systemName || '', origin: { campaignId: scope.campaignId, branchId: scope.branchId }, confirmed: { fingerprint: RESERVE_TARGETS[type].fingerprint(row), name: row.name, classes: null, gameTime: gameTimeOf(scope) } })

const refOfView = (view) => ({ type: view.type, id: view.id, name: view.name, systemId: view.systemId, systemName: view.systemName, origin: { campaignId: view.origin.campaignId, branchId: view.origin.branchId }, confirmed: copyOf(view.confirmed) })

const entryPayload = (entry) => ({ source: refOfView(entry.source), scenario: entry.scenario, reserves: copyOf(entry.reserves), plans: copyOf(entry.plans), note: entry.note })

// The next free plan id of a list of plans: p1, p2, and so on.
export const nextPlanId = (plans) => {
  let number = 1

  while (plans.some((plan) => plan.id === `p${number}`)) {
    number++
  }

  return `p${number}`
}

// The payload of a record with the lines of `resources` replaced by the ones given, and every line of another resource kept as it is: `reserves` is `{ resource: amount }` (an absent or null amount is no reserve) and `plans` `{ id?, label, resource, kind, amount, day }`, a plan with no id given the next free one. A panel edits only the resources it covers, so what another panel keeps in the same record is never lost.
export const editedPayload = (payload, { resources, reserves = {}, plans = [], note }) => {
  const kept = payload.plans.filter((plan) => !resources.includes(plan.resource))
  const issued = [...kept]
  const added = plans.map((plan) => {
    const made = { id: plan.id || nextPlanId(issued), label: typeof plan.label === 'string' ? plan.label.trim() : plan.label, resource: plan.resource, kind: plan.kind, amount: plan.amount, day: plan.day }

    issued.push(made)

    return made
  })

  return {
    ...payload,
    reserves: { ...Object.fromEntries(Object.entries(payload.reserves).filter(([resource]) => !resources.includes(resource))), ...Object.fromEntries(Object.entries(reserves).filter(([resource, amount]) => resources.includes(resource) && amount !== null && amount !== undefined && amount !== '')) },
    plans: [...kept, ...added],
    note: note === undefined ? payload.note : typeof note === 'string' ? note.trim() : note,
  }
}

const emptyPayload = (source, scenario) => ({ source, scenario, reserves: {}, plans: [], note: '' })

// Keeps a record: a new one when `entry` is null, else the record `entry` names, edited over the revision the entry was read at. A new record needs `source` (`{ type: 'colony' | 'ship' | 'class', row }`, the row as `loadReserveObjects` gave it) and `scenario`; a record belongs to one source and one scenario for good, so an edit takes neither. `resources` names the resources the panel covers and `reserves` and `plans` their lines (`editedPayload`); a ship or a ship class keeps a fuel reserve alone. A pick is made only against `context`, the objects of the open save for this race, campaign and branch (with its `RaceID`, `campaignId` and `branchId`): an object that is not in it as picked, or that was picked for another race, campaign or branch, is refused. A source and a scenario that have a record in this campaign and branch already are refused, so there is one record for each; a record shared with the campaign must not meet another of the same source and scenario on any branch. A stale edit is refused with the stored record unless `overwrite` says it is to be written over.
export const saveReserve = async (repository, scope, { entry = null, source, scenario, resources, reserves = {}, plans = [], note, context = null, policy, overwrite = false }) => {
  try {
    const allowed = await mayWrite(repository, scope, 'reserve record')

    if (!allowed.ok) {
      return allowed
    }

    const invalid = (message) => ({ ok: false, code: 'invalid-reserve', message })

    if (!Array.isArray(resources) || !resources.length || !resources.every((resource) => RESOURCE_KEYS.includes(resource))) {
      return invalid('The resources the record covers are a list of the ledger\'s resources.')
    }

    if (entry && (source !== undefined || scenario !== undefined)) {
      return invalid(`A record belongs to one ${nounOf(entry.source.type)} and one scenario for good: delete it and make another for a different ${nounOf(entry.source.type)} or scenario.`)
    }

    let checked = null
    let name = null

    if (!entry) {
      if (!(isObject(source) && hasOwn(RESERVE_TARGETS, source.type) && isObject(source.row))) {
        return invalid('A record is about one colony, ship or ship class: pick it.')
      }

      name = typeof scenario === 'string' ? scenario.trim() : scenario

      const problem = scenarioProblem(name)

      if (problem) {
        return invalid(`The scenario is not valid: ${problem}.`)
      }

      checked = checkLink(context, scope, { type: source.type, row: source.row }, RESERVE_TARGETS, 'reserve record')

      if (!checked.ok) {
        return checked
      }
    }

    const type = entry ? entry.source.type : source.type
    const noun = nounOf(type)
    const sourceId = entry ? entry.source.id : checked.row.id
    const scenarioName = entry ? entry.scenario : name
    const listedAt = (branchId) => repository.list({ ...scope, branchId }, { kind: RESERVE_KIND }).filter((item) => item.payload && item.payload.source && item.payload.source.type === type && item.payload.source.id === sourceId && item.payload.scenario === scenarioName && !item.flags.some((flag) => NOT_SHOWN.includes(flag)) && !(entry && item.record.uuid === entry.uuid))

    if (!entry && listedAt(scope.branchId).length) {
      return { ok: false, code: 'exists', message: `This ${noun} ID has a record for this scenario already in this campaign and branch: edit it, or review it if the ${noun} is not the one it was made for.` }
    }

    // A record shared with the campaign shows on every branch, so it must not meet another record of the source and scenario on any of them: a new one, and one that is widened.
    if (policy === 'campaign' && (!entry || entry.policy !== 'campaign')) {
      const branches = context && isObject(context.branches) ? Object.keys(context.branches) : []

      if ([...new Set([scope.branchId, ...branches])].some((branchId) => listedAt(branchId).length > 0)) {
        return { ok: false, code: 'exists', message: `This ${noun} has a record for this scenario on this or another branch of the campaign, so sharing this one would give it two: delete or edit the other first.` }
      }
    }

    const base = entry ? entryPayload(entry) : emptyPayload(refOf(type, checked.row, scope), name)
    const made = editedPayload(base, { resources, reserves, plans, note })
    const problems = problemsOf(made)

    if (problems.length) {
      return invalid(`The record is not valid: ${problems.join('; ')}`)
    }

    if (Object.keys(made.reserves).length === 0 && made.plans.length === 0) {
      return invalid('The record keeps no reserve and plans nothing: set one, or delete the record.')
    }

    if (!entry) {
      return { ok: true, record: repository.create(scope, { kind: RESERVE_KIND, policy: policy || 'branch', links: [{ type, id: checked.row.id, row: checked.row }], assumptions: assumptionsOf(type), payload: made }) }
    }

    const patch = { payload: made, assumptions: assumptionsOf(type), ...(policy && policy !== entry.policy ? { policy } : {}) }

    try {
      return { ok: true, record: repository.update(scope, entry.uuid, entry.revision, patch) }
    } catch (error) {
      if (!error || error.name !== 'RevisionConflict') {
        throw error
      }

      if (!overwrite) {
        return { ok: false, code: 'revision-conflict', message: error.message, stored: copyOf(error.stored.payload), revision: error.stored.revision }
      }

      return { ok: true, record: repository.reconcile(scope, error, { ...patch, payload: editedPayload(error.stored.payload, { resources, reserves, plans, note }) }) }
    }
  } catch (error) {
    return failure(error)
  }
}

// Confirms the source that now holds the ID of a record's source, when the save does not show it is the one the record was made for (the verdict is `review`): the source is made again from that object as the open save has it, the link with it, and the confirmation is the player's, on this branch. It is refused for a source that is held, gone or not read. A stale revision is refused with the code 'revision-conflict'.
export const confirmSource = async (repository, scope, { entry, context = null }) => {
  try {
    const allowed = await mayWrite(repository, scope, 'reserve record')

    if (!allowed.ok) {
      return allowed
    }

    const view = entry ? entry.source : null

    if (!view || view.verdict.state !== VERDICTS.REVIEW || !view.row) {
      return { ok: false, code: 'not-in-review', message: `The ${view ? nounOf(view.type) : 'source'} is not waiting for review, so there is nothing to confirm.` }
    }

    const checked = checkLink(context, scope, { type: view.type, row: view.row }, RESERVE_TARGETS, 'reserve record')

    if (!checked.ok) {
      return checked
    }

    const payload = { ...entryPayload(entry), source: refOf(view.type, checked.row, scope) }
    const problems = problemsOf(payload)

    if (problems.length) {
      return { ok: false, code: 'invalid-reserve', message: `The record is not valid: ${problems.join('; ')}` }
    }

    try {
      return { ok: true, record: repository.update(scope, entry.uuid, entry.revision, { payload, links: [{ type: view.type, id: checked.row.id, row: checked.row }], assumptions: assumptionsOf(view.type) }) }
    } catch (error) {
      if (!error || error.name !== 'RevisionConflict') {
        throw error
      }

      return { ok: false, code: 'revision-conflict', message: error.message, stored: copyOf(error.stored.payload), revision: error.stored.revision }
    }
  } catch (error) {
    return failure(error)
  }
}

// Deletes a record over the revision the entry was read at; a stale revision is refused and nothing is deleted.
export const deleteReserve = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope, 'reserve record')

    return allowed.ok ? { ok: true, record: repository.delete(scope, entry.uuid, entry.revision) } : allowed
  } catch (error) {
    return failure(error)
  }
}

// Moves a record made at a later game time than the open save (an `ahead` record) to the open save, on the open branch: the explicit step that makes it current. It is refused for a record that is not ahead, and for a source and scenario that have another record on the open branch already; a stale revision is refused with the code 'revision-conflict'. What the record names is checked as for any record once it is current.
export const rebaseReserve = async (repository, scope, entry) => {
  try {
    const allowed = await mayWrite(repository, scope, 'reserve record')

    if (!allowed.ok) {
      return allowed
    }

    if (!entry || !entry.ahead) {
      return { ok: false, code: 'not-ahead', message: 'The record was not made after this save, so there is nothing to move.' }
    }

    const other = repository.list(scope, { kind: RESERVE_KIND }).some((item) => item.record.uuid !== entry.uuid && item.payload && item.payload.source && item.payload.source.type === entry.source.type && item.payload.source.id === entry.source.id && item.payload.scenario === entry.scenario && item.status !== 'ahead' && !item.flags.some((flag) => NOT_SHOWN.includes(flag)))

    if (other) {
      return { ok: false, code: 'exists', message: `This ${nounOf(entry.source.type)} has another record for this scenario on this branch already: delete or edit that one first.` }
    }

    try {
      return { ok: true, record: repository.update(scope, entry.uuid, entry.revision, { rebase: true }) }
    } catch (error) {
      if (!error || error.name !== 'RevisionConflict') {
        throw error
      }

      return { ok: false, code: 'revision-conflict', message: error.message, stored: copyOf(error.stored.payload), revision: error.stored.revision }
    }
  } catch (error) {
    return failure(error)
  }
}
