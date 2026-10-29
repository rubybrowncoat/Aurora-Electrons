/*
  Checks the spans of time that the count-format mixin (src/renderer/mixins/count-format.js) writes for the pages (`duration` in days, `span` in seconds): a figure of a thousand or more is written in the grouping of the "Thousands Separator" setting, as a count is, so that a span of a million years reads `910'038'079.5 y` and not `910038079.5 y` (the Empty in column of the deficit sites of Mineral Outlook), and the shorter spans read as they did.

  bun scripts/check-count-format.js [--no-mutations] [mutant:<N> ...]

  The mixin's source is run in each of the five settings, with the texts written out here by hand: the figure of a long span grouped in the character of the setting (Tick, Comma, Dash, Space, or nothing for None) with its decimal kept after a point, a figure under a thousand written whole, the unit chosen at its thresholds (hours under a day, days under 60, months under 730 days, years beyond), a span of seconds that runs on into days and years, and a value that is not known (null, undefined, NaN, infinite, empty) written as a dash and never as an hour.

  Each planted fault rewrites one line of a copy of the mixin's source and must make a check fail; `mutant:<N>` runs only the fault of that number. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')

const FILE = path.resolve(__dirname, '..', 'src', 'renderer', 'mixins', 'count-format.js')
const DAY = 86400
const YEAR_DAYS = 365
// What each name of the setting puts between groups of three digits, written out here and never read from the app.
const GROUPINGS = { Tick: '\'', Comma: ',', Dash: '-', Space: ' ', None: '' }
const DASH = '—'

// The mixin built from its source text: its imports given by the caller, its methods and computed properties as the component would have them.
const built = (text, math) => {
  const body = text.replace(/^import .*$/gm, '').replace('export default {', 'return {')

  // eslint-disable-next-line no-new-func
  return new Function('mapGetters', 'countText', 'isKnownNumber', 'thousandsSeparator', body)(() => ({}), math.countText, math.isKnownNumber, math.thousandsSeparator)
}

// A component of the mixin with the setting set to `name`.
const mounted = (mixin, name) => {
  const view = { config: { get: (key, fallback) => (key === 'selectedSeparator' ? name : fallback) }, ...mixin.methods }

  Object.defineProperty(view, 'separator', { get: () => mixin.computed.separator.call(view) })

  return view
}

const CHECKS = [
  ['a long span of years is grouped in the character of each setting, its decimal kept', (view, group) => {
    assert.equal(view.duration(910038079.5 * YEAR_DAYS), `910${group}038${group}079.5 y`)
    assert.equal(view.duration(12345678.9 * YEAR_DAYS), `12${group}345${group}678.9 y`)
    assert.equal(view.duration(1234 * YEAR_DAYS), `1${group}234 y`)
    assert.equal(view.duration(1000 * YEAR_DAYS), `1${group}000 y`)
  }],
  ['a figure under a thousand years is written whole, as it was', (view) => {
    assert.equal(view.duration(999.9 * YEAR_DAYS), '999.9 y')
    assert.equal(view.duration(2.3 * YEAR_DAYS), '2.3 y')
    assert.equal(view.duration(730), '2 y')
  }],
  ['the unit is the one that reads best: hours, days, months, then years', (view) => {
    assert.equal(view.duration(0.125), '3 h')
    assert.equal(view.duration(0.01), '1 h')
    assert.equal(view.duration(12.5), '12.5 d')
    assert.equal(view.duration(59.94), '59.9 d')
    assert.equal(view.duration(60), '2 mo')
    assert.equal(view.duration(4.1 * 30.4), '4.1 mo')
    assert.equal(view.duration(400), '13.2 mo')
  }],
  ['a span of seconds runs on into days and into grouped years', (view, group) => {
    assert.equal(view.span(45), '45 s')
    assert.equal(view.span(200), '3 min 20 s')
    assert.equal(view.span(7530), '2 h 5 min')
    assert.equal(view.span(12.5 * DAY), '12.5 d')
    assert.equal(view.span(1234.5 * YEAR_DAYS * DAY), `1${group}234.5 y`)
  }],
  ['a value that is not known is a dash, never an hour or a year', (view) => {
    for (const unknown of [null, undefined, NaN, Infinity, '']) {
      assert.equal(view.duration(unknown), DASH, String(unknown))
      assert.equal(view.span(unknown), DASH, String(unknown))
    }
  }],
]

// The planted faults: the text of the mixin to find (exactly once) and what replaces it. Each must make a check fail.
/* eslint-disable no-template-curly-in-string */
const MUTATIONS = [
  ['the years are written with no grouping', '`${this.count(days / 365, 1)} y`', '`${Math.round(days / 365 * 10) / 10} y`'],
  ['the years are grouped with the apostrophe whatever the setting', '`${this.count(days / 365, 1)} y`', '`${countText(days / 365, 1)} y`'],
  ['the years are written to a whole number', '`${this.count(days / 365, 1)} y`', '`${this.count(days / 365)} y`'],
  ['a year is 360 days', '`${this.count(days / 365, 1)} y`', '`${this.count(days / 360, 1)} y`'],
  ['a month is 30 days', '`${this.count(days / 30.4, 1)} mo`', '`${this.count(days / 30, 1)} mo`'],
  ['months run to a year', '} else if (days < 730) {', '} else if (days < 365) {'],
  ['a value that is not known is taken for a number', 'if (!isKnownNumber(days)) {', 'if (false) {'],
  ['a span of seconds counts its days in hours', 'return this.duration(seconds / 86400)', 'return this.duration(seconds / 3600)'],
]
/* eslint-enable no-template-curly-in-string */

const failures = (mixin) => CHECKS.flatMap(([name, test]) => Object.entries(GROUPINGS).flatMap(([setting, group]) => {
  try {
    test(mounted(mixin, setting), group)

    return []
  } catch (error) {
    return [`${name} (${setting})`]
  }
}))

const main = async () => {
  const { math } = await loadUtilities(['math']).then((loaded) => ({ math: loaded.math }))
  const text = fs.readFileSync(FILE, 'utf8')
  const wanted = process.argv.filter((argument) => /^mutant:\d+$/.test(argument)).map((argument) => Number(argument.slice('mutant:'.length)))
  const mutating = !process.argv.includes('--no-mutations')
  let checks = 0
  let failed = 0
  const report = (ok, name, detail = '') => {
    checks++
    failed += ok ? 0 : 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
  }

  if (!wanted.length) {
    const mixin = built(text, math)

    for (const [name, test] of CHECKS) {
      const wrong = Object.entries(GROUPINGS).filter(([setting, group]) => {
        try {
          test(mounted(mixin, setting), group)

          return false
        } catch (error) {
          console.log(`      ${setting}: ${error.message.split('\n').slice(0, 3).join(' | ')}`)

          return true
        }
      }).map(([setting]) => setting)

      report(!wrong.length, name, wrong.join(', '))
    }
  }

  if (mutating || wanted.length) {
    console.log('\nMutations: each must fail at least one check')

    for (const [index, [name, from, to]] of MUTATIONS.entries()) {
      if (wanted.length && !wanted.includes(index)) {
        continue
      }

      try {
        const broken = failures(built(patched(FILE, text, from, to), math))

        report(broken.length > 0, `mutant:${index} caught: ${name}`, broken.length ? `${broken.length} checks fail` : 'every check still passes')
      } catch (error) {
        report(false, `mutant:${index} caught: ${name}`, error.message)
      }
    }
  }

  console.log(`\n${checks - failed} of ${checks} checks passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
