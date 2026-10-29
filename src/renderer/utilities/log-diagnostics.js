// The Game Log's short-interval checklist: the fire and boarding events one race's log holds for a recent window of game time, with how far the log covers that window, and the inputs the checklist could not read. It lists evidence and names no cause: an event is a row the game wrote, and the absence of one is never read as the absence of the thing (docs/plans/backlog/evidence/AE-161-01.md sections 3.3, 8.2 and 8.6).
//
// The window ends at the newest increment the open save holds and reaches back `seconds`. The race's rows come from a read of the open save (`readRaceEvents`), merged in memory (never written) into the branch's archive when the race keeps one, so a window that reaches before the save is covered by what was archived. `coverageOf` turns the record into the window's state: 'observed', 'partial' (a gap, an open increment or a failed read falls inside it) or 'unavailable'. Each event also carries the state of its own increment.

import { EVENT_FIELDS, coverageOf, endOf, fingerprint, gapsOf, mergeCapture, openStretchesOf, readRaceEvents, withFailure } from './event-archive'
import { EVENT_ICONS } from './event-icons'
import { categoryOfType } from './event-triage'
import { isKnownNumber } from './math'
import { envelope, failureWords, registerRule, unavailable } from './provenance'

const VERSIONS = ['2.7.x']

// The event types the checklist watches, all of the Combat category of utilities/event-triage.js (scripts/check-event-triage.js holds each to the export of DIM_EventType), with the icon the log shows for the type. `group` is 'fire' or 'boarding'. None of them says why an interval stalls.
export const WATCHED = Object.freeze([
  { type: 119, name: 'Fire Delay', group: 'fire' },
  { type: 341, name: 'Attacked By AA Fire', group: 'fire' },
  { type: 219, name: 'Boarding Attempt', group: 'boarding' },
  { type: 220, name: 'Boarding Combat', group: 'boarding' },
  { type: 297, name: 'Boarding Underway', group: 'boarding' },
  { type: 342, name: 'Boarding Damage', group: 'boarding' },
].map((entry) => Object.freeze({ ...entry, category: categoryOfType(entry.type), icon: EVENT_ICONS[entry.type] || 'mdi-text-box-outline' })))

export const GROUPS = Object.freeze({ fire: 'Fire', boarding: 'Boarding' })

const WATCHED_BY_TYPE = new Map(WATCHED.map((entry) => [entry.type, entry]))

// The windows offered, in seconds of game time.
export const WINDOWS = Object.freeze([
  { seconds: 3600, text: 'Last hour' },
  { seconds: 86400, text: 'Last day' },
  { seconds: 432000, text: 'Last 5 days' },
  { seconds: 2592000, text: 'Last 30 days' },
])

export const DEFAULT_WINDOW = 86400

// The glossary entries (utilities/glossary.js) that hold the manual checks in the game: the checklist names them and never acts on the game.
export const POINTER_TERMS = Object.freeze(['cease-fire', 'fleet-cease-fire', 'ship-open-fire', 'game-events-window'])

// Most observations listed at once, newest first; the count of the rest is told.
export const LISTED = 25

export const STATE_TEXT = Object.freeze({ observed: 'Observed', partial: 'Partial', unavailable: 'Unavailable' })

// The sentence the panel draws for each verdict, after the count of the found verdict. Never worded as safe or as nothing having happened: the log keeps only what the game wrote.
export const VERDICT_TEXT = Object.freeze({
  found: Object.freeze({
    one: 'fire or boarding event observed in this window. They are rows the game wrote and do not show why an interval stalls.',
    many: 'fire or boarding events observed in this window. They are rows the game wrote and do not show why an interval stalls.',
  }),
  absent: 'None of the watched event types was found in the observed part of this window. The log keeps only what the game wrote, so this says nothing about the game beyond the log.',
  unavailable: 'Unknown. No read of the log covers this window, so nothing can be said of it.',
})

// What makes a window partial, in words, by the kind the coverage names.
export const REASON_TEXT = Object.freeze({
  gap: 'a stretch of the window lies in a gap between observed spans',
  before: 'the window reaches before the first observed span',
  after: 'the window reaches past the newest observed span',
  head: 'the window meets the oldest increment of an observed span, which the load may have cut',
  tail: 'the window meets the newest increment of an observed span, which later events may still join',
  failure: 'a read of the log failed at a time inside the window',
  cut: 'the archive no longer holds the oldest events, and the window starts before the cut',
})

// The words a watched type's line draws where its count is no figure: not known (no read of the log covers the window) or none observed.
export const COUNT_TEXT = Object.freeze({ unknown: 'unknown', none: 'none observed' })

// The marks a watched type's line may carry: the race hid the type in the game's Events window, or the save's event table does not list it.
export const MARK_TEXT = Object.freeze({ hidden: 'Hidden in the game\'s Events window', unlisted: 'Not in this save\'s event table' })

registerRule({
  id: 'logDiagnostic.events',
  versions: VERSIONS,
  units: 'events',
  verification: 'confirmed',
  structure: ['FCT_GameLog.EventType', 'FCT_GameLog.Time', 'FCT_GameLog.MessageText', 'FCT_GameLog.IncrementID', 'FCT_GameLog.SMOnly', 'FCT_Increments'],
  note: 'The events listed are rows of the race\'s game log, read as stored, and the window\'s state says how far the read covers it. A count is a count of rows observed, never a claim about what else happened: a stretch no read covers is unknown, not an interval with no events.',
})

registerRule({
  id: 'logDiagnostic.hidden',
  versions: VERSIONS,
  units: 'event types',
  verification: 'confirmed',
  structure: ['FCT_HideEvents.EventID'],
  note: 'The event types the race hid in the game\'s own Events window, as stored. The log keeps the rows of a hidden type, so a type listed here is in the log and not in that window until all events are shown.',
})

registerRule({
  id: 'logDiagnostic.types',
  versions: VERSIONS,
  units: 'event types',
  verification: 'confirmed',
  structure: ['DIM_EventType.EventTypeID'],
  note: 'Whether the open save\'s event table lists a watched type. A type the table lacks may not exist in the save\'s game version, so no row of it is not an observation of anything.',
})

registerRule({
  id: 'logDiagnostic.fleet',
  versions: VERSIONS,
  units: '',
  verification: 'confirmed',
  structure: [],
  note: 'The checklist reads no ship, fleet or boarding-party state. The sample save has no table of boarding parties, and the fire-control tables are not read for this checklist.',
})

// ---- Reading --------------------------------------------------------------------------------------------------------

// The event types the race hid in the game's Events window, as a Set, or null when they could not be read (unknown, never none).
export const readHiddenTypes = async (database, GameID, RaceID) => {
  try {
    const [rows] = await database.query(`select FCT_HideEvents.EventID from FCT_HideEvents where FCT_HideEvents.GameID = ${Number(GameID)} and FCT_HideEvents.RaceID = ${Number(RaceID)}`)

    return new Set(rows.map((row) => Number(row.EventID)))
  } catch (error) {
    return null
  }
}

// The watched types the save's event table lists, as a Set, or null when the table could not be read.
export const readListedTypes = async (database) => {
  try {
    const [rows] = await database.query(`select DIM_EventType.EventTypeID from DIM_EventType where DIM_EventType.EventTypeID in (${WATCHED.map((entry) => entry.type).join(', ')})`)

    return new Set(rows.map((row) => Number(row.EventTypeID)))
  } catch (error) {
    return null
  }
}

// What one diagnostic needs from the open save, read once for a race: { capture, failed, archive, hidden, listed, GameTime }. `window` is the log's window when the page has it, `archive` the race's archived record or null, `GameTime` the save's game time.
export const readDiagnostic = async (database, { GameID, RaceID, GameTime, window = null, archive = null }) => {
  const [read, hidden, listed] = await Promise.all([
    readRaceEvents(database, { GameID, RaceID, t: GameTime, window }),
    readHiddenTypes(database, GameID, RaceID),
    readListedTypes(database),
  ])

  return Object.freeze({ capture: read.capture || null, failed: read.failed || null, archive, hidden, listed, GameTime: isKnownNumber(GameTime) ? Number(GameTime) : null })
}

// ---- Judging --------------------------------------------------------------------------------------------------------

// The archive as the checklist merges the open save's read into it: the archive's cut says what it no longer holds, not what the save still holds, so it is left out and the read adds every row it has. The archive itself is not changed (a copy is made).
const withoutCut = (archive) => (archive ? { ...archive, cut: undefined } : archive)

// The record the window is read from: the archive with the open save's read merged in (in memory), the archive with the failed read noted, or the archive as it is when the log holds no row.
const recordOf = ({ capture, failed, archive, GameTime }) => {
  if (capture) {
    return mergeCapture(withoutCut(archive), capture, { now: () => 0 }).record
  }

  if (failed && archive) {
    return withFailure(archive, { at: 0, t: GameTime, reason: failed.message })
  }

  return archive
}

// The kinds of reason a coverage names, in order: the window reaches before the first observed span, meets a gap between spans, reaches past the newest span, meets the oldest or the newest increment of a span, meets a failed read, or starts before the archive's cut.
const reasonsOf = (coverage, record) => {
  if (coverage.state === 'unavailable') {
    return []
  }

  const gaps = gapsOf(record)
  const meets = (gap) => (gap.from === null || gap.from < coverage.to) && gap.to > coverage.from
  const touched = (kind) => coverage.openStretches.some((stretch) => stretch.kind === kind)
  const reasons = []

  if (gaps.length && meets(gaps[0])) {
    reasons.push('before')
  }

  if (gaps.slice(1).some(meets)) {
    reasons.push('gap')
  }

  if (coverage.spans.length && coverage.spans[coverage.spans.length - 1][1] < coverage.to) {
    reasons.push('after')
  }

  if (touched('head')) {
    reasons.push('head')
  }

  if (touched('tail')) {
    reasons.push('tail')
  }

  if (coverage.failures.length) {
    reasons.push('failure')
  }

  if (coverage.cut !== null) {
    reasons.push('cut')
  }

  return reasons
}

const STATE_STATUS = Object.freeze({ observed: 'confirmed', partial: 'estimated' })

const eventsResult = (coverage, reasons, value) => (coverage.state === 'unavailable' ? unavailable({ rule: 'logDiagnostic.events', missing: ['a capture of the race\'s log that covers the window'] }) : envelope({ value, status: STATE_STATUS[coverage.state], rule: 'logDiagnostic.events', inputs: { present: ['FCT_GameLog'], missing: reasons.map((reason) => REASON_TEXT[reason]) } }))

const setResult = (set, rule, name, listed) => (set === null ? unavailable({ rule, missing: [name] }) : envelope({ value: listed, status: 'confirmed', rule, inputs: { present: [name] } }))

// The checklist for a window of `seconds` ending at the newest increment the save holds: { window, state, reasons, verdict, observed, types, observations, results } or null when no window can be placed (no save time, no log). `verdict` is 'found', 'absent' (nothing of a watched type in what was observed of the window) or 'unavailable' (nothing observed of it); `absent` never means the thing did not happen. An event of a game-master-only row is never listed or counted.
export const diagnose = (inputs, seconds) => {
  const { capture, failed, hidden, listed, GameTime } = inputs
  const to = capture ? endOf(capture.to) : GameTime

  if (!isKnownNumber(to)) {
    return null
  }

  const from = to - seconds
  const record = recordOf(inputs)
  const stretches = openStretchesOf(record)
  const coverage = coverageOf(record, from, to, stretches)
  const reasons = reasonsOf(coverage, record)
  const states = new Map()
  const stateOf = (increment) => {
    if (!states.has(increment[0])) {
      states.set(increment[0], coverageOf(record, increment[1], endOf(increment), stretches).state)
    }

    return states.get(increment[0])
  }
  const observations = []

  if (coverage.state !== 'unavailable') {
    const TIME = EVENT_FIELDS.indexOf('Time')
    const TYPE = EVENT_FIELDS.indexOf('EventType')
    const TEXT = EVENT_FIELDS.indexOf('MessageText')
    const GAME_MASTER = EVENT_FIELDS.indexOf('SMOnly')

    record.increments.forEach((increment) => increment[3].forEach((group) => {
      if (WATCHED_BY_TYPE.has(group[TYPE]) && group[TIME] > from && group[TIME] <= to && !group[GAME_MASTER]) {
        observations.push({ key: fingerprint(increment[0], group.slice(0, EVENT_FIELDS.length)), type: group[TYPE], time: group[TIME], message: group[TEXT] || '', increment: increment.slice(0, 3), copies: group[EVENT_FIELDS.length], state: stateOf(increment) })
      }
    }))
  }

  observations.sort((a, b) => b.time - a.time || b.increment[0] - a.increment[0] || a.type - b.type)

  const types = WATCHED.map((entry) => {
    const own = observations.filter((observation) => observation.type === entry.type)

    return { ...entry, count: own.reduce((sum, observation) => sum + observation.copies, 0), newest: own.length ? own[0].time : null, listed: listed === null ? null : listed.has(entry.type), hidden: hidden === null ? null : hidden.has(entry.type) }
  })
  const observed = observations.reduce((sum, observation) => sum + observation.copies, 0)
  const verdict = coverage.state === 'unavailable' ? 'unavailable' : observed ? 'found' : 'absent'

  return {
    window: { from, to, seconds },
    state: coverage.state,
    coverage,
    reasons,
    verdict,
    observed,
    types,
    observations,
    failed: failed ? failureWords(failed) : null,
    results: {
      events: eventsResult(coverage, reasons, { from, to, observed, verdict }),
      hidden: setResult(hidden, 'logDiagnostic.hidden', 'the event types the race hides', hidden ? [...hidden].sort((a, b) => a - b) : []),
      types: setResult(listed, 'logDiagnostic.types', 'the event types the game lists', listed ? [...listed].sort((a, b) => a - b) : []),
      fleet: unavailable({ rule: 'logDiagnostic.fleet', missing: ['ship, fleet and boarding-party state'] }),
    },
  }
}
