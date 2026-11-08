/* Focused roster, reload and industrial decimal regressions. Run with bun scripts/check-industry-edges.js [--no-mutations]. */
const fs = require('fs')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { mutating, refusePlanting } = require('./lib/no-mutations')

const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const cases = [
  ['age', (m) => {
    const person = { Name: 'Officer', GraduationAge: 21, CareerStart: 100 }
    assert.equal(m.commanders.ageResult(person, 100 + 0.55 * 31536000).value, 21)
    assert.equal(m.commanders.ageResult(person, 100 + 31536000).value, 22)
    assert.equal(m.commanders.ageResult(person, 99).value, 20)
  }],
  ['reload', (m) => {
    const design = (RateOfFire) => m['designed-tech'].augmentComponent({ CategoryID: 3, ComponentTypeID: 3, Name: String(RateOfFire), RateOfFire, HangarReloadOnly: 1 })
    const sample = design(1250)
    assert.equal(sample.HangarReload, 20)
    assert.equal(sample.MFReload, 3)
    const rows = [design(60), design(61)]
    const f = { count: String }
    for (const column of m['designed-tech'].categoryColumnsMap[3].filter((column) => column.value === 'RateOfFire')) {
      const cells = rows.map((row) => m['designed-tech'].cellOf(column, row, f))
      const marks = m['designed-tech'].compareMarks(column, rows, cells, true)
      assert.equal(marks.verdict, null)
      assert.ok(marks.marks.every((mark) => mark.mark === null))
    }
    const mixed = [design(60), { ...design(2), HangarReloadOnly: 0 }]
    const reload = m['designed-tech'].categoryColumnsMap[3].find((column) => column.value === 'RateOfFire')
    const ranked = m['designed-tech'].compareMarks(reload, mixed, mixed.map((row) => m['designed-tech'].cellOf(reload, row, f)), true)
    assert.equal(ranked.marks[1].verdict, 'best')
    const column = m['designed-tech'].categoryColumnsMap[51].find((column) => column.value === 'HangarReload')
    assert.equal(m['designed-tech'].compareMarks(column, rows, rows.map((row) => m['designed-tech'].cellOf(column, row, f)), true).verdict, null)
  }],
  ['training-residual', (m) => {
    const rate = m.provenance.ofRule({ rule: 'production.trainingRate', value: 100 })
    assert.equal(m.production.finishDays({ rule: 'production.trainingFinish', rate, remaining: -1, remainingName: 'the remaining training' }).result.value, 3.65)
  }],
  ['stock-cover', (m) => {
    const project = { ID: 1, ProductionType: 0, Percentage: 100, Amount: 1, PartialCompletion: 0, ProdPerUnit: 1, Queue: 0, Paused: 0, FuelRequired: 0, ConversionFrom: null, ...Object.fromEntries(m.minerals.MINERALS.flatMap(({ name }) => [[name, 0], [`Stock${name}`, 0]])), Duranium: 1, StockDuranium: 0.00006, StockFuel: 0 }
    const capacity = m.provenance.ofRule({ rule: 'production.industryRate', value: 1 })
    const result = m.production.industryForecast({ projects: [project], capacities: { construction: capacity, ordnance: capacity, fighter: capacity }, modifiers: { MinConstructionPeriod: 31536000 } }).figures[0]
    assert.equal(result.covers.value, 0)
    assert.deepEqual(result.covers.rule.versions, ['3.2.x'])
  }],
  ['decimal-build', (m) => {
    const job = (ID, Percentage = 100, needs = {}) => ({ ID, Percentage, Amount: 1, PartialCompletion: 0, ProdPerUnit: 1, Queue: 0, Paused: false, category: 'construction', needs })
    const run = (extra = {}) => m['industry-cycle'].forecastColony({ projects: [job(1)], capacities: { construction: 0.00006 }, stock: {}, cycleDays: 365, horizonDays: 3650, ...extra })
    assert.equal(run().projects[1].built, 0)
    assert.equal(run({ capacities: { construction: 1 }, projects: [job(1, 100, { Duranium: 1 })], stock: { Duranium: 0.00006 } }).projects[1].built, 0)
    assert.equal(run({ capacities: { construction: 1 }, projects: [job(1, 100, { fuel: 1 })], stock: { fuel: 0.00006 } }).projects[1].firstBuild, 0.00006)
    const contested = run({ capacities: { construction: 0.0002 }, projects: [job(1, 50, { Duranium: 1 }), job(2, 50, { Duranium: 1 })], stock: { Duranium: 0.0001 } })
    assert.deepEqual(contested.orders.contested, [1, 2])
    assert.deepEqual(contested.projects[1].builtRange, [0, 0.0001])
    const input = { capacities: { construction: 0.00016 }, stock: {}, horizonDays: 3650000 }
    const jumped = run(input)
    assert.equal(jumped.projects[1].finish, 3650000)
    assert.deepEqual(jumped, run({ ...input, stepwise: true }))
    assert.equal(jumped.projects[1].roundingError, 0.625)
  }],
]
const FAULTS = [
  { name: 'fractional career years', target: 'commanders', from: 'Math.floor((Number(until) - Number(person.CareerStart)) / SECONDS_PER_YEAR)', to: '(Number(until) - Number(person.CareerStart)) / SECONDS_PER_YEAR', fails: 'age' },
  { name: 'fractional hangar minutes', target: 'designed-tech', from: 'Math.trunc(item.RateOfFire / 60)', to: 'item.RateOfFire / 60', fails: 'reload' },
  { name: 'fractional facility hours', target: 'designed-tech', from: 'Math.trunc(item.RateOfFire / 360)', to: 'item.RateOfFire / 360', fails: 'reload' },
  { name: 'rank raw reload seconds', target: 'designed-tech', from: 'column.compareValue ? column.compareValue(row) : row[column.value]', to: 'row[column.value]', fails: 'reload' },
  { name: 'signed training balance', target: 'production', from: "rule === 'production.trainingFinish' ? Math.abs(remaining) : remaining", to: 'remaining', fails: 'training-residual' },
  { name: 'round mineral builds upward', target: 'industry-cycle', from: 'requested = floorBuild(requested)', to: 'requested = divide(floor(add(multiply(requested, BUILD_SCALE), fromString(\'0.5\'))), BUILD_SCALE)', fails: 'decimal-build' },
  { name: 'accelerate with an unfloored step', target: 'industry-cycle', from: 'step: floorBuild(units)', to: 'step: units', fails: 'decimal-build' },
  { name: 'exclude an exactly covered mineral step', target: 'industry-cycle', from: 'entry.inclusive ? !less(stock, entry.least) : greater(stock, entry.least)', to: 'greater(stock, entry.least)', fails: 'decimal-build' },
  { name: 'report half-step floor error', target: 'industry-cycle', from: '1 / SCALE / units', to: '1 / SCALE / 2 / units', fails: 'decimal-build' },
]
const modules = ['commanders', 'designed-tech', 'production', 'industry-cycle', 'component-calc', 'provenance', 'minerals']
const failuresOf = (m) => cases.flatMap(([name, run]) => {
  try { run(m); return [] } catch (error) { return [{ name, message: error.message }] }
})
const main = async () => {
  const head = failuresOf(await loadUtilities(modules, { stubs: STUBS }))
  let failed = head.length
  let checks = cases.length
  cases.forEach(([name]) => console.log(`${head.some((entry) => entry.name === name) ? 'FAIL' : 'PASS'}  ${name}`))
  head.forEach((entry) => console.log(entry.message))
  for (const fault of mutating() ? FAULTS : []) {
    refusePlanting(fault.name)
    const text = fs.readFileSync(path.join(__dirname, '../src/renderer/utilities', `${fault.target}.js`), 'utf8')
    const parts = text.split(fault.from)
    assert.equal(parts.length, 2, fault.name)
    const broken = failuresOf(await loadUtilities(modules, { stubs: STUBS, sources: { [fault.target]: parts.join(fault.to) } }))
    const caught = !head.length && broken.some((entry) => entry.name === fault.fails)
    checks++
    if (!caught) failed++
    console.log(`${caught ? 'PASS' : 'FAIL'}  caught ${fault.name}`)
  }
  console.log(`${checks - failed} of ${checks} checks passed`)
  process.exitCode = failed ? 1 : 0
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
