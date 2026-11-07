/*
  Checks the one formatter of a measured range, `rangeText` of src/renderer/utilities/math.js, which the pages write a low and a high figure with: the unit once, after the second figure ("5–9 L", "5.3 M to 9.2 M L"), an en dash between plain numbers and " to " after a magnitude suffix (K, M, B, bn and the like) or beside a negative value, so a dash never sits beside a suffix or a minus sign; figures in different units keep each unit and are joined with " to "; a duration range writes its unit once when both ends carry the same single unit ("5–9 s") and keeps each end's own text joined with " to " when an end carries two parts or the ends carry different units ("3 min 20 s to 4 min 10 s", "5 h to 6 d"); equal ends as displayed show one value; an end that is not known shows the caller's unknown wording. The litres' own figure, `compactFigure` of utilities/logistics.js, carries the magnitude apart so the logistics page writes the unit once.

  bun scripts/check-range-text.js [--no-mutations] [mutant:<N> ...]

  The utilities are loaded as the pages load them (scripts/lib/utilities.js) and the texts are written out here by hand. Each planted fault rewrites one line of a copy of the formatter's source and must make a check fail; `mutant:<N>` runs only the fault of that number. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { mutating, refusePlanting } = require('./lib/no-mutations')
const { patched } = require('./lib/mutant-source')

const FILE = path.resolve(__dirname, '..', 'src', 'renderer', 'utilities', 'math.js')
const DASH = '—'

// The figures each check writes with: litres through the page's own compact figure, a plain whole number, a decimal length with its unit, a temperature in Celsius, and durations as the pages write them, a span of two parts marked compound.
const formats = (m) => ({
  litres: (value) => m.logistics.compactFigure(value, ' L'),
  tenths: (value) => m.math.rangeFigure(m.math.roundToDecimal(value, 1), { unit: ' L' }),
  celsius: (value) => m.math.rangeFigure(m.math.roundToDecimal(value, 1), { unit: ' °C', negative: value < 0 }),
  days: (value) => (value < 1 ? m.math.rangeFigure(m.math.roundToDecimal(value * 24, 1), { unit: ' hours' }) : m.math.rangeFigure(m.math.roundToDecimal(value, 1), { unit: ' days' })),
  seconds: (value) => m.math.rangeFigure(`${Math.round(value)}`, { unit: ' s' }),
  hours: (value) => m.math.rangeFigure(`${Math.round(value)}`, { unit: ' h' }),
  spans: (value) => (value < 60 ? m.math.rangeFigure(`${value}`, { unit: ' s' }) : value % 60 ? m.math.rangeFigure(`${Math.floor(value / 60)} min ${value % 60} s`, { compound: true }) : m.math.rangeFigure(`${Math.floor(value / 60)}`, { unit: ' min' })),
  mixed: (value) => (value < 86400 ? m.math.rangeFigure(`${Math.round(value / 3600)}`, { unit: ' h' }) : m.math.rangeFigure(`${Math.round(value / 86400)}`, { unit: ' d' })),
})

const CHECKS = [
  ['plain ends are joined with an en dash and the unit written once', (m, f) => {
    assert.equal(m.math.rangeText(5, 9, { format: f.litres }), '5–9 L')
    assert.equal((m.math.rangeText(5, 9, { format: f.litres }).match(/L/g) || []).length, 1)
    assert.equal(m.math.rangeText(5, 9), '5–9')
    assert.equal(m.math.rangeText(1234, 5678), '1\'234–5\'678')
  }],
  ['a shortened first value is joined with " to ", the magnitude kept on each figure', (m, f) => {
    assert.equal(m.math.rangeText(5300000, 9200000, { format: f.litres }), '5.3 M to 9.2 M L')
    assert.equal(m.math.rangeText(2500000000, 3400000000, { format: f.litres }), '2.5 bn to 3.4 bn L')
  }],
  ['a plain first value keeps the dash before a shortened second one', (m, f) => {
    assert.equal(m.math.rangeText(900, 1200000, { format: f.litres }), '900–1.2 M L')
    assert.equal(m.math.rangeText(900000, 1200000, { format: f.litres }), '900 k to 1.2 M L')
  }],
  ['a negative end is joined with " to ", never a dash beside the minus sign', (m, f) => {
    assert.equal(m.math.rangeText(-20, 15, { format: f.celsius }), '-20 to 15 °C')
    assert.equal(m.math.rangeText(10, -5, { format: f.celsius }), '10 to -5 °C')
    assert.equal(m.math.rangeText(12.3, 15.4, { format: f.celsius }), '12.3–15.4 °C')
  }],
  ['equal ends as displayed show one value with the unit', (m, f) => {
    assert.equal(m.math.rangeText(5, 5, { format: f.litres }), '5 L')
    assert.equal(m.math.rangeText(5310000, 5320000, { format: f.litres }), '5.3 M L')
    assert.equal(m.math.rangeText(5.31, 5.34, { format: f.tenths }), '5.3 L')
    assert.equal(m.math.rangeText(0, 0, { format: f.litres }), '0 L')
  }],
  ['an unknown end shows the caller\'s unknown wording, never a range', (m, f) => {
    for (const unknown of [null, undefined, NaN, Infinity, '']) {
      assert.equal(m.math.rangeText(unknown, 5, { format: f.litres }), DASH, String(unknown))
      assert.equal(m.math.rangeText(5, unknown, { format: f.litres }), DASH, String(unknown))
    }

    assert.equal(m.math.rangeText(null, 5, { format: f.litres, unknown: 'Not known' }), 'Not known')
  }],
  ['figures in different units keep each unit and are joined with " to "', (m, f) => {
    assert.equal(m.math.rangeText(0.5, 2, { format: f.days }), '12 hours to 2 days')
    assert.equal(m.math.rangeText(1.5, 2, { format: f.days }), '1.5–2 days')
  }],
  ['a duration range writes its unit once when both ends carry the same single unit', (m, f) => {
    assert.equal(m.math.rangeText(5, 9, { format: f.seconds }), '5–9 s')
    assert.equal(m.math.rangeText(36, 48, { format: f.hours }), '36–48 h')
    assert.equal((m.math.rangeText(5, 9, { format: f.seconds }).match(/ s\b/g) || []).length, 1)
    assert.equal(m.math.rangeText(5.2, 5.4, { format: f.seconds }), '5 s')
  }],
  ['a compound or mixed-unit duration range keeps each end\'s own text joined with " to "', (m, f) => {
    assert.equal(m.math.rangeText(200, 250, { format: f.spans }), '3 min 20 s to 4 min 10 s')
    assert.equal(m.math.rangeText(5, 65, { format: f.spans }), '5 s to 1 min 5 s')
    assert.equal(m.math.rangeText(5 * 3600, 6 * 86400, { format: f.mixed }), '5 h to 6 d')
  }],
  ['the litres figure keeps the text it wrote before the formatter existed', (m) => {
    assert.equal(m.logistics.compact(5300000), '5.3 M')
    assert.equal(m.logistics.compact(1200000), '1.2 M')
    assert.equal(m.logistics.compact(900), '900')
    assert.equal(m.logistics.compact(2500000000), '2.5 bn')
  }],
]

// The planted faults: the text of the formatter to find (exactly once) and what replaces it. Each must make a check fail.
const MUTATIONS = [
  ['always the dash', 'first.magnitude || first.negative || last.negative ? \' to \' : \'–\'', '\'–\''],
  ['the unit kept on both ends', 'figureText(first, \'\')', 'figureText(first)'],
  ['equal ends drawn as a range', 'if (figureText(first) === figureText(last)) {', 'if (false) {'],
  ['an unknown end taken for a figure', 'if (!isKnownNumber(low) || !isKnownNumber(high)) {', 'if (false) {'],
  ['a compound duration drawn as a range', 'if (first.compound || last.compound) {', 'if (false) {'],
  ['a duration in two units drawn with one', 'if (first.unit !== last.unit) {', 'if (false) {'],
]

const failures = (m) => {
  const f = formats(m)

  return CHECKS.flatMap(([name, run]) => {
    try {
      run(m, f)

      return []
    } catch (error) {
      return [`${name}: ${error.message.split('\n').slice(0, 4).join(' | ')}`]
    }
  })
}

const main = async () => {
  const text = fs.readFileSync(FILE, 'utf8')
  const wanted = process.argv.filter((argument) => /^mutant:\d+$/.test(argument)).map((argument) => Number(argument.slice('mutant:'.length)))
  let checks = 0
  let failed = 0
  const report = (ok, name, detail = '') => {
    checks++
    failed += ok ? 0 : 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
  }

  if (!wanted.length) {
    const head = failures(await loadUtilities(['math', 'logistics']))

    CHECKS.forEach(([name]) => report(!head.some((entry) => entry.startsWith(`${name}:`)), name))
    head.forEach((entry) => console.log(`      ${entry}`))
  }

  if (mutating() || wanted.length) {
    console.log('\nMutations: each must fail at least one check')

    for (const [index, [name, from, to]] of MUTATIONS.entries()) {
      if (wanted.length && !wanted.includes(index)) {
        continue
      }

      refusePlanting(name)

      try {
        const broken = failures(await loadUtilities(['math', 'logistics'], { sources: { math: patched(FILE, text, from, to) } }))

        report(broken.length > 0, `mutant:${index} caught: ${name}`, broken.length ? `${broken.length} checks fail: ${broken[0]}` : 'every check still passes')
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
