// The Game Log's view of the event archive (utilities/event-archive.js): the branch's file read for a race, and the archive's rows as the page's list rows, so the list, the filters and the timeline treat them as they treat the save's own.

import { EVENT_FIELDS, archiveRows, eventFileProblem } from './event-archive'
import { eventStore } from './history'
import { gameDateText } from './history-milestones'

const LOOKUP_CHUNK = 400
const SYSTEM = EVENT_FIELDS.indexOf('SystemID')
const POPULATION = EVENT_FIELDS.indexOf('PopulationID')
const GAME_MASTER = EVENT_FIELDS.indexOf('SMOnly')

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// The branch's archive file read for a race: { status: 'ok', record } (record null when the race has none yet) or { status: 'unavailable', reason }. Frozen, so nothing in a record of up to 100,000 events is made reactive.
export const readArchiveFile = (campaignId, branchId, RaceID) => {
  try {
    const file = eventStore(campaignId, branchId).store
    const reason = eventFileProblem(file)

    if (reason) {
      return Object.freeze({ status: 'unavailable', reason })
    }

    const record = isObject(file) && isObject(file.races) && isObject(file.races[RaceID]) ? file.races[RaceID] : null

    return Object.freeze({ status: 'ok', record })
  } catch (error) {
    return Object.freeze({ status: 'unavailable', reason: error.message })
  }
}

// What the player may see of the archive and the pins. A game-master-only event is kept in the archive and in a stored pin but is never listed, counted or quoted in a player-facing row, so every view goes through these.

// The conflicts of a record without those that quote a game-master-only event.
export const playerConflicts = (record) => (record ? record.conflicts.filter((conflict) => !(conflict.group && conflict.group[GAME_MASTER])) : [])

// The pins without those on a game-master-only event.
export const playerPins = (pins) => pins.filter((pin) => !pin.fields[GAME_MASTER])

// Whether a log row may be pinned: a game-master-only row cannot, whichever list it came from.
export const pinnableRow = (row) => !row.SMOnly

// How many events of a record are game-master-only, counting identical rows one by one.
export const gameMasterCount = (record) => (record ? record.increments.reduce((sum, increment) => sum + increment[3].reduce((count, group) => count + (group[GAME_MASTER] ? group[EVENT_FIELDS.length] : 0), 0), 0) : 0)

// The system and colony IDs a record's events name.
const idLists = (record) => {
  const systems = new Set()
  const colonies = new Set()

  record.increments.forEach((increment) => increment[3].forEach((group) => {
    if (group[SYSTEM] > 0) {
      systems.add(group[SYSTEM])
    }

    if (group[POPULATION] > 0) {
      colonies.add(group[POPULATION])
    }
  }))

  return { systems, colonies }
}

const chunked = (ids) => Array.from({ length: Math.ceil(ids.length / LOOKUP_CHUNK) }, (_, index) => ids.slice(index * LOOKUP_CHUNK, (index + 1) * LOOKUP_CHUNK))

// The names the events of a record need, looked up by numeric ID lists in the open save: { types: Map(EventTypeID -> description), colours: Map(EventTypeID -> { AlertColour, TextColour }), systems: Map(SystemID -> name), colonies: Map(PopulationID -> { name, SystemID }) }. An ID the save lacks is absent from its map.
export const readArchiveNames = async (database, GameID, RaceID, record) => {
  const game = Number(GameID)
  const race = Number(RaceID)
  const { systems, colonies } = idLists(record)
  const [types] = await database.query('select DIM_EventType.EventTypeID, DIM_EventType.Description from DIM_EventType')
  const [colours] = await database.query(`select FCT_EventColour.EventTypeID, FCT_EventColour.AlertColour, FCT_EventColour.TextColour from FCT_EventColour where FCT_EventColour.GameID = ${game} and FCT_EventColour.RaceID = ${race}`)
  const systemNames = new Map()
  const colonyNames = new Map()

  for (const ids of chunked([...colonies])) {
    const [found] = await database.query(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID from FCT_Population where FCT_Population.GameID = ${game} and FCT_Population.RaceID = ${race} and FCT_Population.PopulationID in (${ids.map(Number).join(', ')})`)

    found.forEach((row) => {
      colonyNames.set(Number(row.PopulationID), { name: row.PopName, SystemID: Number(row.SystemID) })
      systems.add(Number(row.SystemID))
    })
  }

  for (const ids of chunked([...systems].filter((id) => id > 0))) {
    const [found] = await database.query(`select FCT_RaceSysSurvey.SystemID, FCT_RaceSysSurvey.Name from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = ${game} and FCT_RaceSysSurvey.RaceID = ${race} and FCT_RaceSysSurvey.SystemID in (${ids.map(Number).join(', ')})`)

    found.forEach((row) => systemNames.set(Number(row.SystemID), row.Name))
  }

  return Object.freeze({
    types: new Map(types.map((row) => [Number(row.EventTypeID), row.Description])),
    colours: new Map(colours.map((row) => [Number(row.EventTypeID), { AlertColour: row.AlertColour, TextColour: row.TextColour }])),
    systems: systemNames,
    colonies: colonyNames,
  })
}

// The record's events as the page's rows, newest first: the save's row fields (`IncrementID`, `Time`, `EventType`, `MessageText`, the raw `SystemID`, `PopulationID`, `Xcor`, `Ycor`, `IDType`, `SMOnly`), the names, the colours, the date, and `copies` (how many identical rows the event's group holds, each its own row), `increment` (the identity pinned with it) and `archived`. A name the save does not hold shows as the ID.
export const archiveEvents = (record, names, startYear) => {
  const dates = new Map()

  return archiveRows(record).filter((row) => !row.SMOnly).map((row) => {
    if (!dates.has(row.Time)) {
      dates.set(row.Time, gameDateText(startYear, row.Time))
    }

    const DateTime = dates.get(row.Time)
    const colony = row.PopulationID > 0 ? names.colonies.get(row.PopulationID) || null : null
    const system = row.SystemID > 0 ? row.SystemID : colony && colony.SystemID > 0 ? colony.SystemID : null
    const colour = names.colours.get(row.EventType)
    const TypeName = names.types.has(row.EventType) ? names.types.get(row.EventType) : `Event type ${row.EventType}`
    const SystemName = system === null ? null : names.systems.get(system) || `System ${system}`
    const ColonyName = row.PopulationID > 0 ? (colony ? colony.name : `Colony ${row.PopulationID}`) : null
    const event = {}

    EVENT_FIELDS.forEach((field) => { event[field] = row[field] })

    return {
      ...event,
      id: `${row.key}#${row.copy}`,
      IncrementID: row.IncrementID,
      increment: [row.IncrementID, row.GameTime, row.Length],
      copies: row.copies,
      archived: true,
      TypeName,
      Customized: Boolean(colour),
      AlertColour: colour ? colour.AlertColour : null,
      TextColour: colour ? colour.TextColour : null,
      KnownSystemID: system,
      SystemName,
      ColonyID: row.PopulationID > 0 ? row.PopulationID : null,
      ColonyName,
      SystemBodyID: null,
      DateTime,
      Day: DateTime.slice(0, 10),
      Month: DateTime.slice(0, 7),
      searchText: `${row.MessageText || ''} ${TypeName} ${SystemName || ''} ${ColonyName || ''}`.toLowerCase(),
    }
  })
}
