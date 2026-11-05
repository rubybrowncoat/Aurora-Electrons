/*
  Checks the wealth use categories of the Finances page (utilities/finances.js `buildLedger`, the page's own wealth read and `categoryGroups`, pages/finances.vue): every use sits on the income or the spending side by the Income flag of its DIM_WealthUse row and in the order of its DisplayOrder, so the three project uses (53 Engineering Projects, 54 Ordnance Projects, 55 Ground Unit Projects) and 52 Lost to Independence are spending with their names, no list of use ids is kept in the app, a use the table lacks counts as spending and says so, and the page states the one year the save keeps of the log.

  Run: bun scripts/check-treasury-categories.js [--no-mutations]

  The rule is the game's (`Game.SaveWealthData` keeps a wealth row only while the game time less its time is under `Helpers.SecondsPerYear`, 31,536,000 s, 365 days; `Race.RecordWealthIncome` and `RecordWealthExpense` log a use as income or as spending, and `Population.method_147` records the engineering, ordnance and ground unit projects as uses 53 to 55 and `Race.GrantIndependenceToPopulation` the lost colony as use 52). Every expected figure is written here from the saved rows and the export of the lookup, never read from the module:
  - `lookup`: the fixture's and the shipped database's DIM_WealthUse hold the 54 rows of the export (.github/exports/DIM_WealthUse.csv) with the names, the Income flags and the display orders of uses 52 to 55 (Lost to Independence 29.75, Engineering Projects 6.5, Ordnance Projects 6.6, Ground Unit Projects 6.7, all Income 0), and no stored wealth row of the fixture is a year old or older at the game's time;
  - `ledger`: on a copy of the fixture with logged amounts of the uses 52 to 55 planted at cycle ends of its own log, the page's wealth read run through `buildLedger` lists each use as a spending category with its name, the order of its display order and a total equal to the saved rows (the window's SQL sum), every other category too, and the yearly figures are the totals scaled by 365 days over the span of the window;
  - `classification`: the side of every category is the Income flag of the lookup: a copy whose lookup marks use 53 as income and use 11 as spending moves them, a use the lookup lacks or whose Income is not stored counts as spending, is named from its id and is said not to be in the table;
  - `short`: a log shorter than a year (the rows older than 100 days left out) and a window of 30 days are scaled to a year by the time they span, worked out here from the cycle ends;
  - `page`: the page's wealth read, taken from its source and run on the fixture and the copies, gives the rows of the lookup's names and flags with sums equal to the saved rows and keeps a use the lookup lacks, and the page's `categoryGroups` puts the project uses and Lost to Independence in its Spending group with their totals and none in its Income group;
  - `scan`: no id of the uses 52 to 55 and no name of them is written in the code of the Finances page, its ledger, the treasury log or the shipping runway;
  - `retention`: the Finances page states the retention of the log under the sources panel (365 days, a row a year old or older dropped at saving, so the 365 d window is the whole history and a shorter log is scaled to a year) and the page help and the 365-day constant say the same.
  The fixture holds no logged amount of the uses 52 to 55 (their transactions are written by a game played under 3.1), so `ledger`, `classification`, `page` plant them into in-memory copies (the precedent of scripts/check-light-naval.js); a saved case needs the specimen S8 of AE-310-03.

  Every planted fault must fail the checks it names by a wrong value, never because a call threw. The rewrites that say the same thing must leave every check green.

  Prints `N of N checks passed`; any failed check sets exit code 1, a defect of the harness 2.
*/
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { Database } = require('bun:sqlite')
const { assert, kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')
const { strictRecords } = require('./lib/csv-records')
const { FIXTURE } = require('./lib/fixtures')

const root = path.resolve(__dirname, '..')
const SAVE = FIXTURE.file
const SHIPPED = 'saves/AuroraDB_310_shipped.db'
const EXPORT = '.github/exports/DIM_WealthUse.csv'
const GAME = FIXTURE.gameId
const RACE = FIXTURE.raceId
const DAY = 86400
const NEAR = 1e-9
// The four uses this item names, with the name, the display order and the Income flag the export gives each.
const USES = [
  { id: 53, name: 'Engineering Projects', order: 6.5 },
  { id: 54, name: 'Ordnance Projects', order: 6.6 },
  { id: 55, name: 'Ground Unit Projects', order: 6.7 },
  { id: 52, name: 'Lost to Independence', order: 29.75 },
]

const FILES = {
  finances: path.join(root, 'src', 'renderer', 'utilities', 'finances.js'),
  anchors: path.join(root, 'src', 'renderer', 'utilities', 'treasury-anchors.js'),
  runway: path.join(root, 'src', 'renderer', 'utilities', 'shipping-runway.js'),
  glossary: path.join(root, 'src', 'renderer', 'utilities', 'glossary.js'),
  financesPage: path.join(root, 'src', 'renderer', 'pages', 'finances.vue'),
}
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')]))

// The packages the utilities import, as the least the checks need of them: no date or numeral is formatted here.
const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
}

const memo = (make) => {
  let made = null

  return () => made || (made = make())
}

const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= NEAR * Math.max(1, Math.abs(a), Math.abs(b))

// ---- The modules and the page as shipped, or with edits planted ---------------------------------------------------
const textWith = (edits = []) => edits.reduce((text, edit) => ({ ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], edit.from, edit.to) }), { ...ORIGINALS })

const worldOf = (texts = { ...ORIGINALS }) => ({
  texts,
  modules: memo(async () => {
    const loaded = await loadUtilities(['finances', 'glossary'], { stubs: STUBS, sources: { finances: texts.finances, glossary: texts.glossary } })

    return { finances: loaded.finances, glossary: loaded.glossary }
  }),
})

// ---- The fixture, as in-memory copies ------------------------------------------------------------------------------
// The distinct cycle ends of the race's own log, every twentieth one and the last: where the amounts of the four uses are planted, so the cycles of the log stay as they are.
const PLANT_STEP = 20

const plantStatements = (times) => {
  const picked = times.filter((_time, index) => index % PLANT_STEP === 0 || index === times.length - 1)

  return picked.flatMap((time, index) => USES.map((use) => `insert into FCT_WealthData (GameID, RaceID, Amount, UseID, TimeUsed) values (${GAME}, ${RACE}, ${use.id * 100 + index * 7.25}, ${use.id}, ${time})`))
}

const PLANTS = {
  intact: () => [],
  planted: (times) => plantStatements(times),
  flipped: (times) => [...plantStatements(times), 'update DIM_WealthUse set Income = 1 where WealthUseID = 53', 'update DIM_WealthUse set Income = 0 where WealthUseID = 11'],
  unmatched: (times) => [...plantStatements(times), 'delete from DIM_WealthUse where WealthUseID = 55', 'update DIM_WealthUse set Income = null where WealthUseID = 54'],
  recent: (times) => [...plantStatements(times), `delete from FCT_WealthData where GameID = ${GAME} and TimeUsed < (select GameTime from FCT_Game where GameID = ${GAME}) - ${100 * DAY}`],
}
let BYTES = null
const COPIES = new Map()

const copyOf = (name) => {
  if (!PLANTS[name]) {
    throw new Error(`no planted copy named ${name}`)
  }

  if (!COPIES.has(name)) {
    BYTES = BYTES || fs.readFileSync(path.join(root, SAVE))

    const database = Database.deserialize(BYTES)
    const times = database.query(`select distinct TimeUsed from FCT_WealthData where GameID = ${GAME} and RaceID = ${RACE} order by TimeUsed`).all().map((row) => row.TimeUsed)

    PLANTS[name](times).forEach((statement) => database.run(statement))
    COPIES.set(name, database)
  }

  return COPIES.get(name)
}

const closeCopies = () => {
  COPIES.forEach((database) => database.close())
  COPIES.clear()
}

// ---- What the save holds, in SQL written here -----------------------------------------------------------------------
const gameTimeOf = (database) => database.query(`select GameTime from FCT_Game where GameID = ${GAME}`).get().GameTime

// The window's logged total of each use of the race (the rows younger than `days` days), with the use's lookup row: by SQL written here and apart from the page's read.
const oracleTotals = (database, days) => database.query(`select FCT_WealthData.UseID, sum(FCT_WealthData.Amount) as Total, DIM_WealthUse.Description, DIM_WealthUse.Income, DIM_WealthUse.DisplayOrder from FCT_WealthData left join DIM_WealthUse on DIM_WealthUse.WealthUseID = FCT_WealthData.UseID where FCT_WealthData.GameID = ${GAME} and FCT_WealthData.RaceID = ${RACE} and FCT_WealthData.TimeUsed > ${gameTimeOf(database)} - ${days * DAY} group by FCT_WealthData.UseID`).all()

const timesOf = (database) => database.query(`select distinct TimeUsed from FCT_WealthData where GameID = ${GAME} and RaceID = ${RACE} order by TimeUsed`).all().map((row) => row.TimeUsed)

// The days the rule says a window's cycles span: from the logged end before the first cycle of the window, else a first cycle as long as the one after it, to the last end.
const oracleCoverage = (database, days) => {
  const times = timesOf(database)
  const gameTime = gameTimeOf(database)
  const steps = times.filter((time) => time > gameTime - days * DAY)
  const before = times.filter((time) => time < steps[0]).pop()
  const start = before === undefined ? steps[0] - (steps[1] - steps[0]) : before

  return (steps[steps.length - 1] - start) / DAY
}

// The template literal of the query after `header` in the page's script, with each placeholder evaluated as the page would: `this` is `scope.this` and the other names are those of `scope.names` (a name the check does not give is the check's defect).
const queryOf = (text, header, scope) => {
  const from = text.indexOf(header)
  const open = text.indexOf('this.database.query(`', from) + 'this.database.query(`'.length
  const close = text.indexOf('`).then(([items])', open)

  if (from < 0 || open < from || close < open) {
    throw new Error(`the Finances page's read ${header.trim()} is not where the check looks for it`)
  }

  return text.slice(open, close).replace(/\$\{([^}]+)\}/g, (_match, expression) => String(vm.runInNewContext(`(function () { return (${expression}) }).call(scopeThis)`, { ...scope.names, scopeThis: scope.this })))
}

const wealthRows = (text, f, database) => database.query(queryOf(text, '    wealth: {\n      get: tracked(\'wealth\'', { this: { GameID: GAME, RaceID: RACE }, names: { HISTORY_DAYS: f.HISTORY_DAYS, SECONDS_PER_DAY: f.SECONDS_PER_DAY } })).all()

// The function of a computed property of the page, run with the properties given as `this`.
const computedOf = (text, name, scope) => {
  const from = text.indexOf(`\n    ${name}() {\n`)
  const to = text.indexOf('\n    },\n', from)

  if (from < 0 || to < from) {
    throw new Error(`the Finances page has no computed ${name} where the check looks for it`)
  }

  return vm.runInNewContext(`(function () {${text.slice(from + `\n    ${name}() {`.length, to)}\n})`, {}).call(scope)
}

const ledgerOf = (f, database, windowDays, text = ORIGINALS.financesPage) => f.buildLedger({ treasury: { WealthPoints: 1000, AnnualWealth: null, GameTime: gameTimeOf(database), StartYear: 2000 }, wealth: wealthRows(text, f, database), windowDays })

const flagOf = (income) => income !== null && income !== undefined && Boolean(income)

// ---- The checks ----------------------------------------------------------------------------------------------------
const CHECKS = []
const check = (name, description, run) => CHECKS.push({ name, description, run })

check('lookup', 'the fixture\'s and the shipped database\'s wealth use table hold the 54 rows of the export, uses 52 to 55 with their names, display orders and an Income of 0, and no stored wealth row of the fixture is a year old or older at the game\'s time', async () => {
  const records = strictRecords(fs.readFileSync(path.join(root, EXPORT), 'utf8')).filter((record) => record.length > 1)
  const [header, ...rows] = records

  assert.deepEqual(header, ['WealthUseID', 'Description', 'Income', 'DisplayOrder'], `the export's columns: ${header.join(', ')}`)
  assert.equal(rows.length, 54, 'the export holds 54 wealth uses')

  const exported = Object.fromEntries(rows.map((row) => [Number(row[0]), { name: row[1], income: Number(row[2]), order: Number(row[3]) }]))

  USES.forEach((use) => assert.deepEqual(exported[use.id], { name: use.name, income: 0, order: use.order }, `use ${use.id} in the export`))

  for (const file of [SAVE, SHIPPED]) {
    const database = new Database(path.join(root, file), { readonly: true })
    const stored = database.query('select WealthUseID, Description, Income, DisplayOrder from DIM_WealthUse order by WealthUseID').all()
    const old = file === SAVE ? database.query('select count(*) as N from FCT_WealthData inner join FCT_Game on FCT_Game.GameID = FCT_WealthData.GameID where FCT_Game.GameTime - FCT_WealthData.TimeUsed >= 31536000').get().N : 0

    database.close()
    assert.equal(stored.length, 54, `${file}: 54 wealth uses`)
    assert.ok(stored.every((row) => exported[row.WealthUseID] && exported[row.WealthUseID].name === row.Description && exported[row.WealthUseID].income === Number(row.Income) && exported[row.WealthUseID].order === row.DisplayOrder), `${file}: every row equals the export's`)
    assert.ok(stored.every((row) => row.Income === 0 || row.Income === 1), `${file}: every use has an Income flag of 0 or 1`)
    assert.equal(old, 0, `${file}: no stored wealth row is a year or more older than the game time`)
  }
})

check('ledger', 'on the copy with the uses 52 to 55 logged, the page\'s wealth read through buildLedger lists them as spending with their names, in the order of their display orders and with totals equal to the saved rows, every other category too, and the yearly figures are the totals scaled to 365 days by the span', async (w) => {
  const { finances: f } = await w.modules()
  const database = copyOf('planted')
  const ledger = ledgerOf(f, database, 365)
  const totals = oracleTotals(database, 365)
  const planted = USES.map((use) => totals.find((row) => row.UseID === use.id))

  assert.ok(planted.every(Boolean), 'the copy logs all four uses')
  assert.equal(ledger.categories.length, totals.length, 'the ledger holds one category per logged use')

  for (const row of totals) {
    const category = ledger.categories.find((one) => one.id === row.UseID)

    assert.ok(category, `use ${row.UseID} is a category`)
    assert.ok(near(category.total, row.Total), `${row.Description}: the category's total ${category.total}, the saved rows' sum ${row.Total}`)
    assert.equal(category.income, flagOf(row.Income), `${row.Description}: income is the lookup's flag ${row.Income}`)
    assert.equal(category.label, row.Description, `use ${row.UseID} is named by the lookup`)
    assert.equal(category.order, row.DisplayOrder, `${row.Description}: ordered by its display order`)
    assert.equal(category.unmatched, false, `${row.Description} is in the table`)
  }

  for (const use of USES) {
    const category = ledger.categories.find((one) => one.id === use.id)

    assert.deepEqual([category.label, category.income, category.order], [use.name, false, use.order], `${use.name}: a spending category of its name and order`)
  }

  const sides = (income) => ledger.categories.filter((category) => category.income === income)
  const byOrder = (income) => totals.filter((row) => flagOf(row.Income) === income).sort((a, b) => a.DisplayOrder - b.DisplayOrder).map((row) => row.UseID)

  assert.deepEqual(sides(false).map((category) => category.id), byOrder(false), 'the spending categories follow the lookup\'s display order')
  assert.deepEqual(sides(true).map((category) => category.id), byOrder(true), 'the income categories follow it too')
  assert.ok(ledger.categories.slice(0, sides(true).length).every((category) => category.income), 'income comes first')
  assert.ok(sides(false).findIndex((category) => category.id === 53) < sides(false).findIndex((category) => category.id === 54) && sides(false).findIndex((category) => category.id === 54) < sides(false).findIndex((category) => category.id === 55) && sides(false).findIndex((category) => category.id === 55) < sides(false).findIndex((category) => category.id === 52), 'the projects stand in order, Lost to Independence after them')

  const days = oracleCoverage(database, 365)

  assert.ok(near(ledger.coverage.value, days), `the window spans ${days} days, not ${ledger.coverage.value}`)

  for (const category of ledger.categories) {
    assert.ok(near(category.perYear, category.total * 365 / days), `${category.label}: a year of it is ${category.total * 365 / days}, not ${category.perYear}`)
  }

  const spendingTotal = totals.filter((row) => !flagOf(row.Income)).reduce((sum, row) => sum + row.Total, 0)
  const incomeTotal = totals.filter((row) => flagOf(row.Income)).reduce((sum, row) => sum + row.Total, 0)

  assert.ok(near(ledger.spending.value, spendingTotal * 365 / days), `spending a year ${spendingTotal * 365 / days}, not ${ledger.spending.value}`)
  assert.ok(near(ledger.income.value, incomeTotal * 365 / days), `income a year ${incomeTotal * 365 / days}, not ${ledger.income.value}`)
  assert.ok(near(ledger.net.value, (incomeTotal - spendingTotal) * 365 / days), 'the net a year is the income less the spending')

  const share = ledger.categories.find((category) => category.id === 53)

  assert.ok(near(share.share, planted[0].Total / spendingTotal), `a project's share of the spending is its total over the side's, not ${share.share}`)
  assert.deepEqual(ledger.assumptions, [], 'every use is in the table, so no use is assumed to be spending')
})

check('classification', 'the side of a category is the Income flag of the lookup and nothing else: a lookup that marks use 53 as income and use 11 as spending moves them, a use the lookup lacks or without a stored Income counts as spending, is named by its id and is said not to be in the table', async (w) => {
  const { finances: f } = await w.modules()
  const flipped = copyOf('flipped')
  const ledger = ledgerOf(f, flipped, 365)
  const totals = oracleTotals(flipped, 365)
  const side = (id) => ledger.categories.find((category) => category.id === id).income

  assert.equal(side(53), true, 'use 53 is income where the lookup says Income 1')
  assert.equal(side(11), false, 'use 11, Worker Taxes, is spending where the lookup says Income 0')
  assert.deepEqual([side(54), side(55), side(52)], [false, false, false], 'the other projects stay spending')
  assert.ok(near(ledger.categories.find((category) => category.id === 53).share, totals.find((row) => row.UseID === 53).Total / totals.filter((row) => flagOf(row.Income)).reduce((sum, row) => sum + row.Total, 0)), 'and its share is of the income side')
  assert.deepEqual(ledger.categories.filter((category) => category.income).map((category) => category.id), totals.filter((row) => flagOf(row.Income)).sort((a, b) => a.DisplayOrder - b.DisplayOrder).map((row) => row.UseID), 'the income side is the lookup\'s')

  const lacking = ledgerOf(f, copyOf('unmatched'), 365)
  const category = (id) => lacking.categories.find((one) => one.id === id)

  assert.equal(category(55).label, 'Unknown (55)', 'a use the table lacks is named from its id')
  assert.deepEqual([category(55).income, category(55).unmatched], [false, true], 'counts as spending and is marked unmatched')
  assert.deepEqual([category(54).income, category(54).unmatched], [false, true], 'a use without a stored Income does too')
  assert.equal(category(54).label, 'Ordnance Projects', 'and keeps the lookup\'s name')
  assert.ok(lacking.assumptions.some((text) => /Unknown \(55\)/.test(text) && /Ordnance Projects/.test(text) && /not in the wealth use table/.test(text) && /count as spending/.test(text)), `the ledger says so: ${lacking.assumptions.join(' | ')}`)
  assert.ok(near(lacking.spending.value, lacking.categories.filter((one) => !one.income).reduce((sum, one) => sum + one.perYear, 0)), 'and the spending takes them')
})

check('short', 'a log shorter than a year and a window of 30 days are scaled to a year by the time they span, the span worked out here from the cycle ends', async (w) => {
  const { finances: f } = await w.modules()
  const recent = copyOf('recent')
  const short = ledgerOf(f, recent, 365)
  const days = oracleCoverage(recent, 365)

  assert.ok(days < 110 && days > 90, `the copy keeps about 100 days of the log: ${days}`)
  assert.ok(near(short.coverage.value, days), `the span of the shorter log ${short.coverage.value} days, worked out ${days}`)
  assert.equal(short.coverage.assumptions.length > 0, true, 'a first cycle with no earlier end is said to be assumed as long as the next')

  for (const category of short.categories) {
    assert.ok(near(category.perYear, category.total * 365 / days), `${category.label}: a year of it from the shorter log ${category.total * 365 / days}, not ${category.perYear}`)
  }

  const month = ledgerOf(f, copyOf('planted'), 30)
  const monthDays = oracleCoverage(copyOf('planted'), 30)
  const totals = oracleTotals(copyOf('planted'), 30)

  assert.ok(near(month.coverage.value, monthDays) && monthDays < 36, `the 30 d window spans ${monthDays} days, not ${month.coverage.value}`)

  for (const row of totals) {
    const category = month.categories.find((one) => one.id === row.UseID)

    assert.ok(near(category.total, row.Total), `${row.Description}: ${category.total} in 30 d, the saved rows' sum ${row.Total}`)
    assert.ok(near(category.perYear, row.Total * 365 / monthDays), `${row.Description}: a year of it from 30 d ${row.Total * 365 / monthDays}, not ${category.perYear}`)
  }
})

check('page', 'the page\'s wealth read, run on the fixture and on the copies, gives the lookup\'s names and flags with sums equal to the saved rows and keeps a use the lookup lacks, and its categoryGroups lists the project uses and Lost to Independence under Spending with their totals and none under Income', async (w) => {
  const { finances: f } = await w.modules()
  const text = w.texts.financesPage

  for (const [label, name] of [['fixture', 'intact'], ['copy with uses 52 to 55', 'planted'], ['copy with the lookup changed', 'flipped'], ['copy lacking lookup rows', 'unmatched']]) {
    const database = copyOf(name)
    const rows = wealthRows(text, f, database)
    const totals = oracleTotals(database, 365)
    const perUse = {}

    rows.forEach((row) => {
      perUse[row.UseID] = perUse[row.UseID] || { total: 0, description: row.Description, income: row.Income, order: row.DisplayOrder }
      perUse[row.UseID].total += row.Amount
    })

    assert.equal(Object.keys(perUse).length, totals.length, `${label}: the read holds each logged use`)

    for (const row of totals) {
      const read = perUse[row.UseID]

      assert.ok(read, `${label}: use ${row.UseID} is read`)
      assert.ok(near(read.total, row.Total), `${label}: ${row.Description}: the read's sum ${read.total}, the saved rows' ${row.Total}`)
      assert.equal(read.description, row.Description ?? `Unknown (${row.UseID})`, `${label}: use ${row.UseID} carries the lookup's name or its id`)
      assert.equal(read.income, row.Income, `${label}: use ${row.UseID} carries the lookup's Income flag`)
      assert.equal(read.order, row.DisplayOrder, `${label}: use ${row.UseID} carries the lookup's display order`)
    }
  }

  const planted = copyOf('planted')
  const ledger = ledgerOf(f, planted, 365, text)
  const groups = computedOf(text, 'categoryGroups', { categories: ledger.categories, ledger })
  const group = (label) => groups.find((one) => one.label === label)

  assert.deepEqual([...groups.map((one) => one.label)], ['Income', 'Spending'], 'the page has an Income group and a Spending group')

  for (const use of USES) {
    const item = group('Spending').items.find((one) => one.id === use.id)

    assert.ok(item, `${use.name} is listed under Spending`)
    assert.equal(item.label, use.name, `use ${use.id} is named ${use.name}`)
    assert.ok(near(item.total, oracleTotals(planted, 365).find((row) => row.UseID === use.id).Total), `${use.name}: the listed total is the saved rows' sum`)
    assert.ok(!group('Income').items.some((one) => one.id === use.id), `${use.name} is not listed under Income`)
  }

  assert.ok(group('Spending').items.every((item) => !item.income) && group('Income').items.every((item) => item.income), 'each group holds its own side')
  assert.equal(group('Income').items.length + group('Spending').items.length, ledger.categories.length, 'every category is in one group')
})

check('scan', 'no id of the uses 52 to 55 and no name of them is written in the code of the Finances page, its ledger, the treasury log or the shipping runway, and no list of use ids decides a side', async (w) => {
  const { parse } = require('vue/compiler-sfc')
  const page = parse({ source: w.texts.financesPage })
  const descriptor = page.descriptor || page
  const code = { 'utilities/finances.js': w.texts.finances, 'utilities/treasury-anchors.js': w.texts.anchors, 'utilities/shipping-runway.js': w.texts.runway, 'pages/finances.vue (script)': descriptor.script.content }
  const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  for (const [file, text] of Object.entries(code)) {
    const source = withoutComments(text)

    assert.deepEqual(source.match(/(?<![\d.])5[2-5](?![\d.])/g) || [], [], `${file} writes no id of the uses 52 to 55`)
    assert.deepEqual(USES.map((use) => use.name).filter((name) => source.includes(name)), [], `${file} writes no name of them`)
    assert.ok(!/\b(spending|expense|income)\w*(Uses|Ids|IDs)\b/.test(source), `${file} keeps no list of use ids by side`)
    assert.ok(!/UseID\s*(===|==|!==|!=)\s*\d/.test(source) && !/UseID\s+in\s*\(/i.test(source) && !/\[\s*\d+(\s*,\s*\d+)+\s*\]\.includes\(\s*\w*\.?UseID/.test(source), `${file} compares no use id with a number`)
  }

  assert.ok(/income: row\.Income/.test(w.texts.finances), 'the ledger reads the side from the row\'s Income')
})

check('retention', 'the Finances page states under its sources panel the retention of the log (365 days, a row a year old or older dropped at saving, the 365 d window the whole history, a shorter log scaled to a year, each use placed by its Income flag), the page help says the same, and the constant is 365 days', async (w) => {
  const { finances: f, glossary: g } = await w.modules()
  const text = w.texts.financesPage
  const from = text.indexOf('<v-card class="panel" data-summary="Compare income sources and spending categories by yearly totals and shares."')
  const card = text.slice(from, text.indexOf('</v-card>', from))
  const foot = card.slice(card.indexOf('<div class="panel-foot caption text--secondary">'))

  assert.equal(f.HISTORY_DAYS, 365, 'the history the yearly figures scale to is 365 days')
  assert.ok(from >= 0 && /<div class="panel-foot caption text--secondary">/.test(foot), 'the sources panel has a footer')
  assert.ok(/^<div class="panel-foot caption text--secondary">Use it to /.test(foot), 'it opens with what the panel is for')
  assert.ok(/The save keeps 365 days of the log/.test(foot), `it states the 365 days: ${foot.slice(0, 120)}`)
  assert.ok(/drops a row a year old or older when it saves/.test(foot), 'and the row it drops')
  assert.ok(/the 365 d window is the whole history/.test(foot), 'and what the longest window holds')
  assert.ok(/a log that spans less than a year is scaled to a year by the time it spans/.test(foot), 'and how a shorter log is read')
  assert.ok(/by its Income flag in the wealth use table, never by a list kept in the app/.test(foot), 'and that the sides come from the table')
  assert.ok(/engineering, ordnance and ground unit projects and Lost to Independence are marked as spending/.test(foot), 'and which uses of the item the table marks as spending')
  assert.ok(!/\b(I|we|you|your|our)\b/i.test(foot.replace(/<[^>]*>/g, '')), 'in the impersonal voice')
  assert.ok(!/\d+\.\d+\.\d+|\b[23]\.[01]\b/.test(foot), 'with no release number')

  const help = g.PAGE_HELP['/finances']

  assert.ok(help.usage.some((line) => /the save keeps no more than 365 d of the log/.test(line)), `the page help states the retention: ${help.usage[0]}`)
  assert.ok(help.usage.some((line) => /by its Income flag in the wealth use table/.test(line)), 'and where the sides come from')
})

// ---- The faults and the rewrites ------------------------------------------------------------------------------------
const INCOME_READ = 'income: row.Income === null || row.Income === undefined ? false : !!row.Income'
const FOOT_RETENTION = 'The save keeps 365 days of the log: the game drops a row a year old or older when it saves, so the 365 d window is the whole history, and a log that spans less than a year is scaled to a year by the time it spans.'

/* eslint-disable no-template-curly-in-string */
const FAULTS = [
  { name: 'the side of a category is the opposite of the Income flag', target: 'finances', from: INCOME_READ, to: 'income: row.Income === null || row.Income === undefined ? false : !row.Income', fails: ['ledger', 'classification', 'page'] },
  { name: 'a list of use ids decides the side of the projects and Lost to Independence', target: 'finances', from: INCOME_READ, to: 'income: [52, 53, 54, 55].includes(row.UseID) ? false : row.Income === null || row.Income === undefined ? false : !!row.Income', fails: ['classification', 'scan'] },
  { name: 'a list of use ids decides the side of the income uses (the flag read only for the rest)', target: 'finances', from: INCOME_READ, to: 'income: row.UseID === 11 ? true : row.Income === null || row.Income === undefined ? false : !!row.Income', fails: ['classification', 'scan'] },
  { name: 'a use the lookup lacks counts as income', target: 'finances', from: INCOME_READ, to: 'income: row.Income === null || row.Income === undefined ? true : !!row.Income', fails: ['classification'] },
  { name: 'a use without a stored Income is not marked unmatched', target: 'finances', from: 'unmatched: row.Income === null || row.Income === undefined,', to: 'unmatched: false,', fails: ['classification'] },
  { name: 'the display order of a use is ignored', target: 'finances', from: 'order: row.DisplayOrder ?? 999', to: 'order: 999', fails: ['ledger'] },
  { name: 'the history a yearly figure is scaled to is 366 days', target: 'finances', from: 'export const HISTORY_DAYS = 365', to: 'export const HISTORY_DAYS = 366', fails: ['ledger', 'short', 'retention'] },
  { name: 'the yearly figure is not scaled by the span', target: 'finances', from: 'perYear: perYearFactor === null ? null : category.total * perYearFactor', to: 'perYear: category.total', fails: ['ledger', 'short'] },
  { name: 'the page reads only the uses the lookup holds', target: 'financesPage', from: 'left join DIM_WealthUse on DIM_WealthUse.WealthUseID = FCT_WealthData.UseID', to: 'inner join DIM_WealthUse on DIM_WealthUse.WealthUseID = FCT_WealthData.UseID', fails: ['page'] },
  { name: 'the page reads every use as income', target: 'financesPage', from: 'DIM_WealthUse.Income as Income', to: '1 as Income', fails: ['page'] },
  { name: 'the page reads the last 30 days of the log only', target: 'financesPage', from: '${HISTORY_DAYS * SECONDS_PER_DAY}', to: '${30 * SECONDS_PER_DAY}', fails: ['page'] },
  { name: 'the page puts the spending uses under Income', target: 'financesPage', from: 'items: categories.filter((category) => !category.income).sort', to: 'items: categories.filter((category) => category.income).sort', fails: ['page'] },
  { name: 'the page keeps a list of the project use ids', target: 'financesPage', from: 'const WINDOW_DAYS = [30, 90, 180, 365]', to: 'const WINDOW_DAYS = [30, 90, 180, 365]\nconst PROJECT_USES = [53, 54, 55]', fails: ['scan'] },
  { name: 'the page states no retention of the log', target: 'financesPage', from: FOOT_RETENTION, to: '', fails: ['retention'] },
  { name: 'the page states 366 days of the log', target: 'financesPage', from: 'The save keeps 365 days of the log', to: 'The save keeps 366 days of the log', fails: ['retention'] },
  { name: 'the page states no source of the sides', target: 'financesPage', from: 'by its Income flag in the wealth use table, never by a list kept in the app', to: 'by the app', fails: ['retention'] },
  { name: 'the sources panel has no footer', target: 'financesPage', from: '<div class="panel-foot caption text--secondary">Use it to see which uses earn and which spend', to: '<div class="caption text--secondary">See which uses earn and which spend', fails: ['retention'] },
  { name: 'the page help leaves the retention out', target: 'glossary', from: '; the save keeps no more than 365 d of the log', to: '', fails: ['retention'] },
  { name: 'the shipping runway keeps a list of the project use ids', target: 'runway', from: 'export const SECONDS_PER_YEAR = HISTORY_DAYS * SECONDS_PER_DAY', to: 'export const SECONDS_PER_YEAR = HISTORY_DAYS * SECONDS_PER_DAY\nconst PROJECT_USES = [53, 54, 55]', fails: ['scan'] },
  { name: 'the treasury log names Lost to Independence in its code', target: 'anchors', from: 'import { isChain } from \'./history\'', to: 'import { isChain } from \'./history\'\nconst LOST = \'Lost to Independence\'', fails: ['scan'] },
]

// Rewrites that say the same thing: the Income read with a loose null test, the display order defaulted with an explicit test, a yearly figure written as a quotient.
const BENIGN = [
  { name: 'the Income read with a loose null test', target: 'finances', from: INCOME_READ, to: 'income: row.Income == null ? false : Boolean(row.Income)' },
  { name: 'the display order defaulted with an explicit test', target: 'finances', from: 'order: row.DisplayOrder ?? 999', to: 'order: row.DisplayOrder === null || row.DisplayOrder === undefined ? 999 : row.DisplayOrder' },
  { name: 'the yearly factor written as a product', target: 'finances', from: 'HISTORY_DAYS / coverage.value', to: 'HISTORY_DAYS * (1 / coverage.value)' },
]
/* eslint-enable no-template-curly-in-string */

// ---- Run ------------------------------------------------------------------------------------------------------------
const run = async (checks, world) => {
  const failures = []

  for (const { name, run: body } of checks) {
    try {
      await body(world)
    } catch (error) {
      failures.push({ name, error })
    }
  }

  return failures
}

const describeFailure = ({ name, error }) => `${name}: ${(error && error.message ? error.message : String(error)).split('\n').slice(0, 6).join('\n  ')}`

// The fixtures each check needs: a check whose fixture is not there is left out and said so.
const NEEDS = { lookup: [SAVE, SHIPPED, EXPORT], ledger: [SAVE], classification: [SAVE], short: [SAVE], page: [SAVE] }
const absent = (one) => (NEEDS[one.name] || []).filter((file) => !fs.existsSync(path.join(root, file)))

const main = async () => {
  const available = CHECKS.filter((one) => !absent(one).length)

  CHECKS.filter((one) => absent(one).length).forEach((one) => console.log(`UNSUPPORTED  ${one.name}: the fixture ${absent(one).join(', ')} is not there`))

  const failures = await run(available, worldOf())
  let passed = available.length - failures.length
  let total = available.length

  failures.forEach((failure) => console.log(`FAIL ${describeFailure(failure)}`))

  if (mutating()) {
    const known = new Set(available.map(({ name }) => name))

    FAULTS.forEach(({ name, fails }) => fails.forEach((id) => assert.ok(CHECKS.some((one) => one.name === id), `${name}: no check named ${id}`)))

    const benignOnly = await run(available, worldOf(textWith(BENIGN)))

    total += 1

    if (benignOnly.length) {
      console.log(`FAIL every rewrite applied: ${benignOnly.map(describeFailure).join('; ')}`)
    } else {
      passed += 1
    }

    const attempts = FAULTS.flatMap((fault) => [[fault, []], [fault, BENIGN]])
    const outcomes = await inParallel(attempts, async ([fault, benign]) => {
      const texts = textWith()

      texts[fault.target] = plantedPatch(FILES[fault.target], texts[fault.target], fault.from, fault.to)

      // The rewrites go onto the faulty source where their text is still there exactly once: a fault may replace the very text a rewrite says again.
      benign.filter((edit) => texts[edit.target].split(edit.from).length === 2).forEach((edit) => {
        texts[edit.target] = patched(FILES[edit.target], texts[edit.target], edit.from, edit.to)
      })

      const world = worldOf(texts)
      const named = fault.fails.filter((id) => known.has(id))
      const missed = []

      for (const id of named) {
        const [failed] = await run(CHECKS.filter((one) => one.name === id), world)

        if (!failed || kindOf(failed.error) !== 'assertion' || isSubjectThrow(failed.error)) {
          missed.push(id)
        }
      }

      return { label: `${fault.name}${benign.length ? ', on the source with every rewrite' : ''}`, missed, named: named.length }
    })

    outcomes.forEach((outcome) => {
      total += 1

      if (outcome instanceof Error) {
        console.log(`FAIL planted fault: ${outcome.message}`)
      } else if (!outcome.named) {
        console.log(`FAIL planted fault ${outcome.label}: none of its checks can run here`)
      } else if (outcome.missed.length) {
        console.log(`FAIL planted fault ${outcome.label}: still passes ${outcome.missed.join(', ')}`)
      } else {
        passed += 1
      }
    })
  }

  console.log(`${passed} of ${total} checks passed`)

  return passed === total
}

main()
  .then((green) => {
    closeCopies()
    process.exit(green ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    closeCopies()
    process.exit(2)
  })
