// What a page shows of an observation record (utilities/observations.js): reading the branch's file for the race, setting the objects of the open save against it, and the words for what it says. The wording says only what was observed: a span starts at a capture and is known at each of its captures, never "unchanged for" the time between them.

import { observationStore } from './history'
import { observationFileProblem, observationOf } from './observations'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// What the branch's file holds of one kind of a race: { status: 'ok', record } (record null while the race has none of the kind) or { status: 'unavailable', reason }. A store that throws is a file that cannot be read.
export const readObservationRecord = (campaignId, branchId, RaceID, kind) => {
  try {
    const file = observationStore(campaignId, branchId).store
    const reason = observationFileProblem(file)

    if (reason) {
      return Object.freeze({ status: 'unavailable', reason })
    }

    const race = isObject(file) && isObject(file.races) && isObject(file.races[RaceID]) ? file.races[RaceID] : null
    const record = race && isObject(race.kinds) && isObject(race.kinds[kind]) ? race.kinds[kind] : null

    return Object.freeze({ status: 'ok', record })
  } catch (error) {
    return Object.freeze({ status: 'unavailable', reason: error.message })
  }
}

// What the record says of each object of the open save: a Map from id to { state, span }. `objects` is [[id, digest]] as the reader of the kind gives it and `open` { t, n } the game time and increments of the open save (readOpenSave), or null when the open save or the record could not be read, which leaves the map empty and every object `unread` (the record is not compared with a save that was not read).
export const observationRows = (record, objects, open) => new Map((objects && open ? objects : []).map(([id, digest]) => [id, observationOf(record, id, digest, open)]))

// What the switch on the page says it does, and the rule the figures follow.
export const OBSERVATION_PURPOSE = 'Records the formations of the race on this branch at each capture, so a row can say since when it has been seen in its place with its elements. Switching it off keeps what was recorded.'
export const OBSERVATION_RULE = 'Observed since is the first capture that saw the formation where it is and as it is. The save keeps no date a formation was set, so nothing before the first capture is claimed, and nothing is known between two captures: a formation that left and came back is not told apart. A move or a change of composition starts a new span, and so does a fork: a span never crosses it, since a formation id is not certified across one.'

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`

// The words for one object: { headline, summary, details: [text] }. `summary` is the short line of a table cell: the captures of the span and its longest interval. `date(seconds)` and `duration(seconds)` are the page's own formats.
export const observationText = ({ state, span }, { date, duration }) => {
  if (state === 'unrecorded') {
    return { headline: 'Not observed yet', summary: 'Nothing captured yet', details: ['The recorder has not captured this branch yet.'] }
  }

  if (state === 'unread') {
    return { headline: 'Not read', summary: 'Not compared', details: ['The open save or the record could not be read for the observation, so nothing is compared.'] }
  }

  if (state === 'ahead') {
    return { headline: 'Record is of a later save', summary: 'Not compared', details: ['The open save is older than the newest capture of this branch, or is another timeline at the same game time, so the record does not describe it.'] }
  }

  if (state === 'new') {
    return { headline: 'Not recorded yet', summary: 'The next capture records it', details: ['Present in the open save only; the next capture records it.'] }
  }

  const details = []

  if (state === 'changed') {
    details.push(`Recorded as it was since ${date(span.first)}; the next capture starts a new span.`)
  } else if (span.basis === 'import') {
    details.push('Its age before the first capture is not known.')
  } else if (span.basis === 'moved') {
    details.push(span.before === null ? 'Moved or changed since an earlier capture.' : `Differed at the capture of ${date(span.before)}: moved or changed after it.`)
  } else if (span.basis === 'branch') {
    details.push('A formation with this id and these elements was seen before the fork of this branch. An id is not certified across a fork, so the span starts at the first capture of this branch.')
  } else if (span.before !== null) {
    details.push(`Not there at the capture of ${date(span.before)}.`)
  }

  const counted = span.captures === 1 ? '1 capture' : `${span.captures} captures, longest interval ${duration(span.longest.to - span.longest.from)}`

  details.push(span.captures === 1 ? 'Seen at one capture only.' : `Seen at ${plural(span.captures, 'capture', 'captures')}, the longest interval between two ${duration(span.longest.to - span.longest.from)}; nothing is known between captures.`)

  if (span.failed > 0) {
    details.push(`${plural(span.failed, 'capture failed', 'captures failed')} inside the span.`)
  }

  if (span.inherited) {
    details.push('The span includes the stretch before the fork of this branch; the stretch to the first capture here is not observed.')
  }

  const since = span.basis === 'import' ? `Observed since import, ${date(span.first)}` : `Observed since ${date(span.first)}`

  return { headline: state === 'changed' ? 'Changed since the last capture' : since, summary: `${counted}${span.failed > 0 ? `, ${span.failed} failed` : ''}${span.inherited ? ', with the stretch before the fork' : ''}`, details }
}

// The account of a whole record for the foot of a panel: the captures it holds, its widest interval, the failed captures, what is no longer kept (past the cap or cleared) and what lies before the fork.
export const recordNote = (record, { date, duration }) => {
  if (!record || !record.captures.length) {
    return 'No capture is recorded on this branch yet.'
  }

  const first = record.captures[0][0]
  const last = record.captures[record.captures.length - 1][0]
  const parts = [`${plural(record.captures.length, 'capture', 'captures')} on this branch, from ${date(first)} to ${date(last)}`]
  let widest = null

  record.captures.slice(1).forEach(([t], index) => {
    if (widest === null || t - record.captures[index][0] > widest) {
      widest = t - record.captures[index][0]
    }
  })

  if (widest !== null) {
    parts.push(`the widest interval between two is ${duration(widest)}`)
  }

  if (record.failures && record.failures.length) {
    parts.push(`${plural(record.failures.length, 'capture failed', 'captures failed')}`)
  }

  if (record.cut !== undefined) {
    parts.push(`captures before ${date(record.cut)} are no longer kept`)
  }

  if (record.seed !== undefined) {
    parts.push(`the captures up to ${date(record.seed)} were taken before the fork of this branch`)
  }

  return `${parts.join('; ')}.`
}
