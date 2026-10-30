// The words a page tells the latest capture that saw an object in (utilities/observation-view.js `lastCaptureLine`): one table, so that what a page draws and what a check reads back are one contract. Pure, with no import, so a check can load it from a source of its own.

const GAP = '\uE000'

// Each entry words the latest capture as a function of its date.
export const LATEST_CAPTURE_WORDS = Object.freeze({
  observed: (date) => `The latest capture that saw it is of ${date}.`,
  changed: (date) => `The latest capture that saw it as recorded is of ${date}.`,
})

// The date a line carries as the entry `state` words it, or null when the line is not that entry's wording: the entry's text is split where its date goes, and a line that starts and ends as the two halves do holds the date between them.
export const readLatestCapture = (state, line) => {
  const [before, after] = LATEST_CAPTURE_WORDS[state](GAP).split(GAP)

  return typeof line === 'string' && line.length >= before.length + after.length && line.startsWith(before) && line.endsWith(after) ? line.slice(before.length, line.length - after.length) : null
}
