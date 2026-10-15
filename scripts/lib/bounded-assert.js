// Node's strict assert, except that a failed equality describes both values in bounded form instead of diffing them. Node 24 builds a line diff of the complete inspection of both values for every failed deepEqual and equal, even when a message is given, and that diff's memory grows with the square of the lines: comparing two Maps of 8,000 entries takes 730 MB, and a mutant of scripts/check-event-archive.js that made two Maps of the 119,000 events of a Falryx save differ drove one process past 200 GB of committed memory, which starved every other process on the machine. The predicates stay Node's own (util.isDeepStrictEqual, Object.is), so what passes and what fails is unchanged; only the text of a failure differs.
const { strict } = require('assert')
const { inspect, isDeepStrictEqual } = require('util')

const LIMIT = 2000

const brief = (value) => {
  const text = inspect(value, { depth: 4, maxArrayLength: 12, maxStringLength: 300, breakLength: 160 })

  return text.length > LIMIT ? `${text.slice(0, LIMIT)} … (${text.length} characters)` : text
}

const bounded = (same, words) => (actual, expected, message) => {
  if (same(actual, expected)) {
    return
  }

  if (message instanceof Error) {
    throw message
  }

  strict.fail(`${message === undefined ? 'Expected values to be' : `${message}: expected values to be`} ${words}\nactual:   ${brief(actual)}\nexpected: ${brief(expected)}`)
}

const deepEqual = bounded(isDeepStrictEqual, 'strictly deep-equal')
const equal = bounded(Object.is, 'strictly equal')

module.exports = { ...strict, deepEqual, deepStrictEqual: deepEqual, equal, strictEqual: equal }
