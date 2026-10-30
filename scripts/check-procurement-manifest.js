/* eslint-disable no-template-curly-in-string */
/*
  Checks the net component procurement manifest (src/renderer/utilities/procurement-manifest.js, its reads in src/renderer/utilities/procurement-data.js, the Procurement manifest panel src/renderer/components/production/ProcurementManifest.vue and its place on the Production page).

  bun scripts/check-procurement-manifest.js [--no-mutations] [--no-saves]

  The manifest is run on hull plans, stock, claims and queued projects worked by hand (labelled synthetic): overlapping plans divide each stocked component once and the stock goes to the first plan in the order listed; the stock at the colony the hulls are needed at is used before the stock elsewhere (the colonies in its system first), and stock before queued manufacture, local before remote; what a task takes is taken when it is made, so a construction or refit task holds nothing, while an automatic refit, a task whose type is not known, an unread task list and a hand entry that is not a number hold back the whole stock of the component they could claim; a stock row with no amount is unknown and an absent row is none; a queued project is counted in whole units from the remaining amount and the part-built unit, a paused or unknown one is no supply, and an unread queue makes a shortage an upper bound; the export separates available, held back, queued and net shortage and local from remote stock, and an unknown figure is an empty cell, never 0.

  The reads run on a small in-memory database of their own (a column or table the save lacks is unknown, not 0), the component and the page are run as pseudo instances and their text is read, and the saves (AuroraDB.db, game 140, race 784, and saves/AuroraDB_271_skoormit_saved.db, game 138, race 785, read-only; one that is not there is skipped and counts as neither a pass nor a failure) give the real reads, compared with raw counts, the manifest of real classes with its allocation invariants, the shared component read (cost and mount counts) against the design data, and copies of the saves in memory (temporary tables over the read-only save) with an automatic refit that holds stock back and a stock row left without an amount.

  Each planted fault in a utility, the component or the page must fail the checks it names. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const U = 'src/renderer/utilities/procurement-manifest.js'
const D = 'src/renderer/utilities/procurement-data.js'
const C = 'src/renderer/components/production/ProcurementManifest.vue'
const P = 'src/renderer/pages/production.vue'
const K = 'src/renderer/utilities/capabilities.js'
const FILES = { [U]: 'procurement-manifest', [D]: 'procurement-data', [K]: 'capabilities' }
const NAMES = ['csv-cell', 'procurement-manifest', 'procurement-data', 'component-calc', 'design-data', 'provenance', 'production', 'minerals', 'capabilities']
const NO_SAVES = process.argv.includes('--no-saves')
const SAVES = [
  { file: 'AuroraDB.db', game: 140, race: 784 },
  { file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
]
const STUBS = {
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

const same = (actual, expected, what) => assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${what}: ${actual} is not ${expected}`)

// A statement that finds no case in the save: printed, in neither the passes nor the failures.
const UNSUPPORTED = Symbol('unsupported')

// ---------- the fixtures worked by hand ----------

const part = (componentId, name, typeId, count, cost = 10, extra = {}) => ({ componentId, name, typeId, count, cost, minerals: {}, prototype: 0, shippingLine: 0, researched: 1, obsolete: 0, ...extra })

// Alpha: two engines, a sensor and four armour plates a hull; Beta: one engine and three sensors a hull. The armour is built with the hull; the engine and the sensor have component projects.
const ENGINE = (count) => part(101, 'Engine', 1, count)
const SENSOR = (count) => part(102, 'Sensor', 2, count)
const ARMOUR = (count) => part(103, 'Armour', 11, count)
const PARTS = { 1: [ENGINE(2), SENSOR(1), ARMOUR(4)], 2: [ENGINE(1), SENSOR(3)] }
// The engine as an alien component: the race has not researched it.
const ALIEN = (count) => part(101, 'Engine', 1, count, 10, { researched: 0 })
const ALIEN_PARTS = { 1: [ALIEN(2), SENSOR(1), ARMOUR(4)], 2: [ALIEN(1), SENSOR(3)] }
const COLONIES = {
  1: { id: 1, name: 'Target', systemId: 10, systemName: 'Home', yards: 1 },
  2: { id: 2, name: 'Far', systemId: 11, systemName: 'Away', yards: 0 },
  3: { id: 3, name: 'Near', systemId: 10, systemName: 'Home', yards: 0 },
}
// The far colony has the lower ID and the larger holding, so only the rule "the same system first" puts the near colony first.
const STOCK = { 1: { 101: 3 }, 3: { 101: 4, 102: 2 }, 2: { 101: 10, 102: 5 } }
const COMPONENTS = { 101: { tons: 50 }, 102: { tons: 100 }, 103: { tons: 25 } }
const PLAN_ALPHA = { id: 1, classId: 1, className: 'Alpha', hulls: 2 }
const PLAN_BETA = { id: 2, classId: 2, className: 'Beta', hulls: 2 }

const input = (over = {}) => ({ plans: [PLAN_ALPHA, PLAN_BETA], parts: PARTS, stock: STOCK, colonies: COLONIES, targetId: 1, projects: [], projectsRead: true, tasks: [], tasksRead: true, entered: [], components: COMPONENTS, ...over })

const rowOf = (result, componentId) => result.rows.find((row) => row.componentId === componentId)

const project = (over = {}) => ({ id: 1, populationId: 1, componentId: 102, amount: 4.0268, partial: 0.9732, paused: 0, name: 'Sensor', ...over })

const withStock = (changes) => ({ ...STOCK, ...Object.fromEntries(Object.entries(changes).map(([id, rows]) => [id, rows])) })

// The cells of a CSV text, as a spreadsheet reads them (quotes and doubled quotes).
const parseCsv = (text) => {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false

  for (let at = 0; at < text.length; at++) {
    const char = text[at]

    if (quoted) {
      if (char === '"' && text[at + 1] === '"') {
        cell += '"'
        at++
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }

  row.push(cell)
  rows.push(row)

  return rows
}

const recordsOf = (csv) => {
  const [header, ...rows] = parseCsv(csv)

  return rows.map((row) => Object.fromEntries(header.map((name, at) => [name, row[at]])))
}

const pure = (ctx) => {
  const { m } = ctx
  const pm = m['procurement-manifest']
  const { provenance } = m
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const run = (over = {}) => pm.reconcile(input(over))

  add('rules: both rules are registered for 2.7.x as estimated', () => {
    const bad = ['production.procurementManifest', 'production.procurementReservations'].filter((id) => { const rule = provenance.getRule(id); return !rule || rule.verification !== 'estimated' || !rule.versions.includes('2.7.x') })

    assert.deepEqual(bad, [])

    return true
  })

  add('once: overlapping plans divide the stock of a component, each unit going to one plan only (engines: 3 here and 1 of 4 near go to Alpha, 2 near to Beta)', () => {
    const result = run()
    const engine = rowOf(result, 101)
    const [alpha, beta] = engine.perPlan

    assert.equal(engine.needed, 6)
    assert.deepEqual([alpha.stockLocal, alpha.stockRemote, alpha.short], [3, 1, 0])
    assert.deepEqual([beta.stockLocal, beta.stockRemote, beta.short], [0, 2, 0])
    assert.equal(engine.used.stockLocal + engine.used.stockRemote, 6)
    assert.equal(engine.net, 0)
    assert.equal(engine.spare, 11)

    return true
  })

  add('once: a component with less stock than the plans together need is short by the difference, not by each plan against all the stock (sensors: 8 needed, 7 held, 1 short)', () => {
    const sensor = rowOf(run(), 102)

    assert.equal(sensor.needed, 8)
    assert.equal(sensor.used.stockLocal + sensor.used.stockRemote, 7)
    assert.deepEqual(sensor.perPlan.map((entry) => entry.short), [0, 1])
    assert.equal(sensor.net, 1)

    return true
  })

  add('once: no lot of stock is taken more than it holds, and a plan\'s lines add up to the row (the same class twice divides the stock too)', () => {
    const result = pm.reconcile(input({ plans: [PLAN_ALPHA, { ...PLAN_ALPHA, id: 3, hulls: 1 }, PLAN_BETA] }))

    for (const row of result.rows) {
      const stock = row.stock.local + row.stock.remote
      const used = row.used.stockLocal + row.used.stockRemote + row.used.queuedLocal + row.used.queuedRemote

      assert.ok(row.used.stockLocal + row.used.stockRemote <= stock + 1e-9, `${row.name} uses more stock than held`)
      same(row.perPlan.reduce((sum, entry) => sum + entry.stockLocal + entry.stockRemote + entry.queuedLocal + entry.queuedRemote, 0), used, `${row.name} lines`)
      same(row.net, row.needed - used, `${row.name} shortage`)
    }

    const engine = rowOf(result, 101)

    assert.equal(engine.needed, 8)
    assert.equal(engine.used.stockLocal, 3)
    assert.equal(engine.used.stockRemote, 5)

    return true
  })

  add('once: a component is needed in the total of the plans, the hulls of each times what a hull mounts', () => {
    const result = run()

    assert.deepEqual(result.rows.map((row) => [row.componentId, row.needed]), [[101, 6], [102, 8], [103, 8]])

    return true
  })

  add('order: the plans are served in the order listed, the first taking the stock (Beta first takes the near sensors, Alpha is left the far ones)', () => {
    const forward = rowOf(run(), 102)
    const backward = rowOf(run({ plans: [PLAN_BETA, PLAN_ALPHA] }), 102)

    assert.deepEqual(forward.perPlan.map((entry) => entry.planId), [1, 2])
    assert.deepEqual(backward.perPlan.map((entry) => [entry.planId, entry.stockRemote, entry.short]), [[2, 6, 0], [1, 1, 1]])
    assert.equal(backward.net, forward.net)

    return true
  })

  add('order: the stock at the colony the hulls are needed at is used before the stock elsewhere, and the colonies in its system before the others', () => {
    const engine = rowOf(run(), 101)

    assert.equal(engine.perPlan[0].stockLocal, 3)
    assert.deepEqual(engine.moves.map((move) => [move.populationId, move.units]), [[3, 3]])
    assert.ok(engine.moves.every((move) => move.sameSystem === true))
    assert.deepEqual(rowOf(run(), 102).moves.map((move) => [move.populationId, move.units]), [[3, 2], [2, 5]])

    return true
  })

  add('order: stock is used before queued manufacture, a project at the colony before one elsewhere', () => {
    const result = run({ projects: [project({ populationId: 2, amount: 3, partial: 0, id: 2 }), project()] })
    const sensor = rowOf(result, 102)

    assert.deepEqual([sensor.used.stockLocal, sensor.used.stockRemote, sensor.used.queuedLocal, sensor.used.queuedRemote], [0, 7, 1, 0])
    assert.equal(sensor.net, 0)
    assert.equal(sensor.netBasis, 'exact')

    const remote = rowOf(run({ projects: [project({ populationId: 2, amount: 3, partial: 0, id: 2 })] }), 102)

    assert.deepEqual([remote.used.queuedLocal, remote.used.queuedRemote, remote.net], [0, 1, 0])
    assert.deepEqual(remote.moves.map((move) => [move.populationId, move.stage, move.units]), [[3, 'stock', 2], [2, 'stock', 5], [2, 'queued', 1]])

    return true
  })

  add('queue: a project holds its remaining amount plus the part-built unit in whole units (46.9502 + 0.0498 = 47, 4.0268 + 0.9732 = 5, 5.4321 + 0.5679 = 6)', () => {
    assert.equal(pm.projectUnits({ amount: 46.9502, partial: 0.0498 }), 47)
    assert.equal(pm.projectUnits({ amount: 4.0268, partial: 0.9732 }), 5)
    assert.equal(pm.projectUnits({ amount: 5.4321, partial: 0.5679 }), 6)
    assert.equal(pm.projectUnits({ amount: 3, partial: 0 }), 3)
    assert.equal(pm.projectUnits({ amount: 3.9, partial: 0 }), 3)
    assert.equal(pm.projectUnits({ amount: null, partial: 0 }), null)
    assert.equal(pm.projectUnits({ amount: 3, partial: null }), null)

    return true
  })

  add('queue: a paused project is listed apart and is no supply; one whose pause flag or units are not known is no supply and makes the shortage an upper bound', () => {
    const paused = rowOf(run({ projects: [project({ paused: 1 })] }), 102)

    assert.equal(paused.queued.local, 0)
    assert.equal(paused.queued.paused, 5)
    assert.equal(paused.net, 1)
    assert.equal(paused.netBasis, 'exact')

    for (const unknown of [project({ paused: null }), project({ amount: null })]) {
      const row = rowOf(run({ projects: [unknown] }), 102)

      assert.equal(row.queued.local, null)
      assert.equal(row.queued.known.local, 0)
      assert.equal(row.net, 1)
      assert.equal(row.netBasis, 'at most')
    }

    return true
  })

  add('queue: a queue that was not read makes a shortage an upper bound, and a component with no shortage stays exact', () => {
    const result = run({ projectsRead: false })

    assert.equal(rowOf(result, 102).netBasis, 'at most')
    assert.equal(rowOf(result, 101).netBasis, 'exact')
    assert.ok(result.unknown.some((text) => text.includes('not read')))

    return true
  })

  add('queue: a project of another component or at no colony in the plans is not counted against a component', () => {
    const row = rowOf(run({ projects: [project({ componentId: 999 })] }), 102)

    assert.equal(row.queued.local + row.queued.remote + row.queued.paused, 0)

    return true
  })

  add('held: a construction or refit task holds nothing (its stock was taken when it was made), a repair or a scrap takes none, and the credit is the class cost less the task total', () => {
    const tasks = [{ id: 1, populationId: 3, typeId: 0, classId: 1, refitId: 0, useComponents: 1, totalBP: 90, classCost: 100 }, { id: 2, populationId: 3, typeId: 2, classId: 1, refitId: 2, useComponents: 1 }, { id: 3, populationId: 3, typeId: 1, classId: 1 }, { id: 4, populationId: 3, typeId: 3, classId: 1 }]
    const result = run({ tasks })

    assert.deepEqual(result.claims, [])
    assert.deepEqual(result.tasks.map((task) => task.state), ['taken', 'taken', 'none', 'none'])
    assert.equal(result.tasks[0].credited, 10)
    assert.deepEqual(result.rows.map((row) => [row.available.local, row.available.remote]), run().rows.map((row) => [row.available.local, row.available.remote]))

    return true
  })

  add('held: an automatic refit holds back the whole stock of the components it adds at its colony (the sensors at the near colony), and one with Use Components off holds none', () => {
    const refit = { id: 1, populationId: 3, typeId: 4, classId: 1, refitId: 2, useComponents: 1 }
    const result = run({ tasks: [refit] })
    const sensor = rowOf(result, 102)
    const engine = rowOf(result, 101)

    assert.deepEqual(sensor.reserved, { proven: 0, unknown: 2 })
    assert.deepEqual([sensor.available.local, sensor.available.remote], [0, 5])
    assert.equal(sensor.net, 3)
    assert.equal(sensor.netBasis, 'at most')
    assert.equal(engine.reserved.unknown, 0)
    assert.equal(engine.netBasis, 'exact')
    assert.deepEqual(result.tasks.map((task) => task.state), ['successors'])

    const off = run({ tasks: [{ ...refit, useComponents: 0 }] })

    assert.deepEqual(off.claims, [])
    assert.equal(rowOf(off, 102).net, 1)

    const unknownFlag = run({ tasks: [{ ...refit, useComponents: null }] })

    assert.equal(rowOf(unknownFlag, 102).reserved.unknown, 2)

    return true
  })

  add('held: a task of a type that is not known, or an unread task list, holds back all the stock it could claim and the shortage is an upper bound', () => {
    const unknownType = run({ tasks: [{ id: 1, populationId: 2, typeId: 9, classId: 1 }] })

    assert.deepEqual(rowOf(unknownType, 102).available, { local: 0, remote: 2, known: { local: 0, remote: 2 } })
    assert.equal(rowOf(unknownType, 102).net, 6)
    assert.equal(rowOf(unknownType, 102).netBasis, 'at most')
    assert.equal(rowOf(unknownType, 101).net, 0)

    const unread = run({ tasksRead: false })

    for (const row of unread.rows) {
      assert.deepEqual(row.available, { local: 0, remote: 0, known: { local: 0, remote: 0 } })
      assert.equal(row.net, row.needed)
      assert.equal(row.netBasis, row.stock.local + row.stock.remote > 0 ? 'at most' : 'exact')
    }

    return true
  })

  add('held: a hand entry of 0 or more holds back that many units; one that is blank or not a number holds back all the stock; entries on one stock never hold back more than it has', () => {
    const proven = rowOf(run({ entered: [{ populationId: 2, componentId: 102, units: 2 }] }), 102)

    assert.deepEqual(proven.reserved, { proven: 2, unknown: 0 })
    assert.deepEqual(proven.available, { local: 0, remote: 5, known: { local: 0, remote: 5 } })
    assert.equal(proven.net, 3)
    assert.equal(proven.netBasis, 'exact')

    const zero = rowOf(run({ entered: [{ populationId: 2, componentId: 102, units: 0 }] }), 102)

    assert.deepEqual(zero.reserved, { proven: 0, unknown: 0 })

    for (const units of [null, NaN, -1]) {
      const blank = rowOf(run({ entered: [{ populationId: 2, componentId: 102, units }] }), 102)

      assert.deepEqual(blank.reserved, { proven: 0, unknown: 5 })
      assert.equal(blank.net, 6)
      assert.equal(blank.netBasis, 'at most')
    }

    const overlap = rowOf(run({ entered: [{ populationId: 2, componentId: 102, units: 3 }, { populationId: 2, componentId: 102, units: 3 }] }), 102)

    assert.deepEqual(overlap.reserved, { proven: 5, unknown: 0 })
    assert.deepEqual(overlap.available, { local: 0, remote: 2, known: { local: 0, remote: 2 } })
    assert.equal(overlap.net, 6)

    return true
  })

  add('held: the held back, the available and the stock add up (stock = held back + available) on every row', () => {
    const results = [run(), run({ entered: [{ populationId: 2, componentId: 102, units: 3 }] }), run({ tasks: [{ id: 1, populationId: 3, typeId: 4, classId: 1, refitId: 2, useComponents: 1 }] }), run({ tasksRead: false })]

    for (const result of results) {
      for (const row of result.rows) {
        same(row.reserved.proven + row.reserved.unknown + row.available.local + row.available.remote, row.stock.local + row.stock.remote, row.name)
      }
    }

    return true
  })

  add('nulls: a stock row with no amount is unknown and not counted (the shortage is an upper bound), an absent row is none held (the shortage is exact)', () => {
    const unknown = run({ stock: withStock({ 3: { 101: 4, 102: null } }) })
    const absent = run({ stock: withStock({ 3: { 101: 4 } }) })

    assert.equal(rowOf(unknown, 102).net, 3)
    assert.equal(rowOf(unknown, 102).netBasis, 'at most')
    assert.ok(unknown.unknown.some((text) => text.includes('Sensor') && text.includes('Near')))
    assert.equal(rowOf(absent, 102).net, 3)
    assert.equal(rowOf(absent, 102).netBasis, 'exact')
    assert.equal(rowOf(unknown, 102).stock.remote, null)
    assert.equal(rowOf(unknown, 102).stock.known.remote, 5)

    return true
  })

  add('unknown: a stock row with no amount makes the stock and the available at that side not known (null, with the known rows beside it), never 0 or the known rows alone; a side with no row at all is none held', () => {
    const elsewhere = rowOf(run({ stock: withStock({ 3: { 101: 4, 102: null } }) }), 102)
    const here = rowOf(run({ stock: withStock({ 1: { 101: 3, 102: null } }) }), 102)
    const absent = rowOf(run({ stock: withStock({ 3: { 101: 4 } }) }), 102)

    assert.deepEqual([elsewhere.stock.local, elsewhere.stock.remote, elsewhere.stock.known.remote], [0, null, 5])
    assert.deepEqual([elsewhere.available.local, elsewhere.available.remote, elsewhere.available.known.remote], [0, null, 5])
    assert.equal(elsewhere.spare, null)
    assert.equal(elsewhere.net, 3)
    assert.equal(elsewhere.netBasis, 'at most')
    assert.deepEqual([here.stock.local, here.stock.remote, here.stock.known.local, here.stock.known.remote], [null, 7, 0, 7])
    assert.deepEqual([here.available.local, here.available.remote], [null, 7])
    assert.deepEqual([absent.stock.local, absent.stock.remote, absent.available.remote], [0, 5, 5])
    assert.equal(absent.spare, 0 + 0)

    return true
  })

  add('unknown: an unknown stock is an empty cell in the export and "not known (N known)" in the text, never a number that is only the rows read', () => {
    const result = run({ stock: withStock({ 3: { 101: 4, 102: null } }) })
    const sensor = recordsOf(pm.manifestCsv(result)).find((record) => record.Record === 'component' && record['Component ID'] === '102')
    const line = pm.manifestText(result).split('\n').find((entry) => entry.startsWith('Sensor (ID 102)'))

    assert.deepEqual([sensor['Stock here'], sensor['Stock elsewhere'], sensor['Available here'], sensor['Available elsewhere'], sensor['Spare stock']], ['0', '', '0', '', ''])
    assert.ok(line.includes('stock here 0, elsewhere not known (5 known)'), line)
    assert.ok(line.includes('available here 0, elsewhere not known (5 known)'), line)
    assert.ok(line.includes('net shortage at most 3'), line)

    return true
  })

  const QUEUED = [project({ populationId: 1, amount: 1.5, partial: 0.5 }), project({ id: 2, populationId: 2, amount: 8, partial: 0 }), project({ id: 3, populationId: 3, amount: 7, partial: 0, paused: 1 })]

  add('text: each component line tells the stock, what is held back, what is available and what is queued here, elsewhere and paused apart (sensors: 2 in stock here, 1 held back, 2 queued here, 8 elsewhere, 7 paused)', () => {
    const result = run({ stock: { 1: { 101: 3, 102: 2 }, 3: { 101: 4 }, 2: { 101: 10 } }, projects: QUEUED, entered: [{ populationId: 1, componentId: 102, units: 1 }] })
    const line = pm.manifestText(result).split('\n').find((entry) => entry.startsWith('Sensor (ID 102)'))

    assert.equal(line, 'Sensor (ID 102): needed 8; stock here 2, elsewhere 0; held back 1 proven; available here 1, elsewhere 0; queued here 2, elsewhere 8, paused 7; net shortage 0')

    return true
  })

  add('manufacture: every colony with a queued or paused project of a component of the plans is listed with its state, its units and how much of it the plans use, whether or not any of it is moved; a paused project is not supply', () => {
    const result = run({ stock: { 1: { 101: 3, 102: 2 }, 3: { 101: 4 }, 2: { 101: 10 } }, projects: QUEUED, entered: [{ populationId: 1, componentId: 102, units: 1 }] })
    const sensor = rowOf(result, 102)
    const entries = sensor.manufacture.map((entry) => [entry.name, entry.state, entry.units, entry.used, entry.unused])

    assert.deepEqual(entries, [['Target', 'queued', 2, 2, 0], ['Far', 'queued', 8, 5, 3], ['Near', 'paused', 7, null, null]])
    assert.deepEqual(sensor.manufacture.map((entry) => [entry.here, entry.sameSystem]), [[true, true], [false, false], [false, true]])
    assert.equal(sensor.net, 0)
    assert.deepEqual(result.moves.filter((move) => move.componentId === 102).map((move) => [move.populationId, move.stage, move.units]), [[2, 'queued', 5]])
    assert.deepEqual(result.manufacture.map((entry) => [entry.componentName, entry.colonyName, entry.state]), [['Sensor', 'Target', 'queued'], ['Sensor', 'Far', 'queued'], ['Sensor', 'Near', 'paused']])

    const withoutPaused = run({ stock: { 1: { 101: 3, 102: 2 }, 3: { 101: 4 }, 2: { 101: 10 } }, projects: QUEUED.slice(0, 2), entered: [{ populationId: 1, componentId: 102, units: 1 }] })

    assert.equal(rowOf(withoutPaused, 102).net, sensor.net)
    assert.deepEqual([rowOf(withoutPaused, 102).queued.local, rowOf(withoutPaused, 102).queued.remote, rowOf(withoutPaused, 102).queued.paused], [2, 8, 0])

    const short = run({ stock: { 1: {} }, projects: [project({ populationId: 3, amount: 3, partial: 0, paused: 1 })] })

    assert.equal(rowOf(short, 102).net, 8)
    assert.equal(rowOf(short, 102).queued.paused, 3)

    return true
  })

  add('manufacture: a queued project the plans do not use is listed with all of its units unused and is no move (engines: 17 in stock for 6 needed, 5 queued at the far colony)', () => {
    const result = run({ projects: [project({ id: 4, populationId: 2, componentId: 101, amount: 5, partial: 0 })] })
    const engine = rowOf(result, 101)

    assert.deepEqual(engine.manufacture.map((entry) => [entry.name, entry.state, entry.units, entry.used, entry.unused]), [['Far', 'queued', 5, 0, 5]])
    assert.equal(result.moves.some((move) => move.stage === 'queued'), false)

    const unknown = run({ parts: { ...PARTS, 2: [ENGINE(null), SENSOR(3)] }, projects: [project({ id: 4, populationId: 2, componentId: 101, amount: 5, partial: 0 })] })

    assert.deepEqual(rowOf(unknown, 101).manufacture.map((entry) => [entry.units, entry.used, entry.unused]), [[5, null, null]])

    return true
  })

  add('manufacture: the export has a manufacture record for each entry, with the colony, state, units and how much the plans use, an empty cell where the plans\' use is not known, and the text has a line for each', () => {
    const result = run({ stock: { 1: { 101: 3, 102: 2 }, 3: { 101: 4 }, 2: { 101: 10 } }, projects: QUEUED, entered: [{ populationId: 1, componentId: 102, units: 1 }] })
    const records = recordsOf(pm.manifestCsv(result)).filter((record) => record.Record === 'manufacture')
    const text = pm.manifestText(result).split('\n')

    assert.deepEqual(records.map((record) => [record.Component, record.Colony, record['Manufacture state'], record['Manufactured units'], record['Used by plans'], record['Not used by plans']]), [['Sensor', 'Target', 'queued', '2', '2', '0'], ['Sensor', 'Far', 'queued', '8', '5', '3'], ['Sensor', 'Near', 'paused', '7', '', '']])
    assert.ok(records[2].Note.includes('paused'))
    assert.ok(text.includes('Manufacture 8 Sensor at Far (queued; 5 used by the plans, 3 not used)'), text.join('\n'))
    assert.ok(text.includes('Manufacture 7 Sensor at Near (paused, not counted as supply)'), text.join('\n'))

    return true
  })

  const FAR_UNKNOWN = project({ id: 5, populationId: 2, amount: null })
  const NEAR_PAUSED_UNKNOWN = project({ id: 6, populationId: 3, amount: null, paused: 1 })

  add('queueunknown: a project with no remaining amount keeps its colony and state with its units not known; the queued total it belongs to is null with the known part beside it, and none of it is supply', () => {
    const result = run({ projects: [FAR_UNKNOWN, NEAR_PAUSED_UNKNOWN] })
    const sensor = rowOf(result, 102)

    assert.deepEqual(sensor.queued, { local: 0, remote: null, paused: null, known: { local: 0, remote: 0, paused: 0 } })
    assert.deepEqual(sensor.manufacture.map((entry) => [entry.name, entry.state, entry.units, entry.incomplete, entry.used, entry.unused]), [['Far', 'queued', null, true, null, null], ['Near', 'paused', null, true, null, null]])
    assert.deepEqual(result.manufacture.map((entry) => [entry.componentName, entry.colonyName]), [['Sensor', 'Far'], ['Sensor', 'Near']])
    assert.equal(sensor.net, rowOf(run(), 102).net)
    assert.equal(sensor.netBasis, 'at most')
    assert.deepEqual(sensor.moves.map((move) => move.stage), ['stock', 'stock'])
    assert.ok(sensor.unknown.some((text) => text.includes('the units left of')))

    return true
  })

  add('queueunknown: a colony with known and unknown projects of the component lists the known units as incomplete, and a pause flag that is not stored keeps the units it has apart from supply', () => {
    const mixed = rowOf(run({ projects: [project({ id: 4, populationId: 2, amount: 2, partial: 0 }), FAR_UNKNOWN] }), 102)
    const unpaused = rowOf(run({ projects: [project({ id: 7, populationId: 3, amount: 3, partial: 0, paused: null })] }), 102)

    assert.deepEqual(mixed.manufacture.map((entry) => [entry.name, entry.units, entry.incomplete, entry.used, entry.unused]), [['Far', 2, true, 1, null]])
    assert.deepEqual(mixed.queued, { local: 0, remote: null, paused: 0, known: { local: 0, remote: 2, paused: 0 } })
    assert.deepEqual(unpaused.manufacture.map((entry) => [entry.name, entry.state, entry.units, entry.incomplete, entry.used]), [['Near', 'not known', 3, false, null]])
    assert.deepEqual(unpaused.queued, { local: 0, remote: null, paused: null, known: { local: 0, remote: 0, paused: 0 } })
    assert.equal(unpaused.net, rowOf(run(), 102).net)

    return true
  })

  add('queueunknown: the export leaves the unknown queued totals and units as empty cells and keeps the colony in a manufacture record, and the text says "not known (N known)" and names the colony', () => {
    const result = run({ projects: [FAR_UNKNOWN, NEAR_PAUSED_UNKNOWN] })
    const records = recordsOf(pm.manifestCsv(result))
    const sensor = records.find((record) => record.Record === 'component' && record['Component ID'] === '102')
    const made = records.filter((record) => record.Record === 'manufacture')
    const text = pm.manifestText(result).split('\n')
    const line = text.find((entry) => entry.startsWith('Sensor (ID 102)'))

    assert.deepEqual([sensor['Queued here'], sensor['Queued elsewhere'], sensor['Queued paused']], ['0', '', ''])
    assert.deepEqual(made.map((record) => [record.Colony, record['Manufacture state'], record['Manufactured units'], record['Used by plans'], record['Not used by plans']]), [['Far', 'queued', '', '', ''], ['Near', 'paused', '', '', '']])
    assert.ok(made[0].Note.includes('units not known'), made[0].Note)
    assert.ok(line.includes('queued here 0, elsewhere not known (0 known), paused not known (0 known)'), line)
    assert.ok(text.includes('Manufacture not known (0 known) Sensor at Far (queued; the use by the plans is not known)'), text.join('\n'))
    assert.ok(text.includes('Manufacture not known (0 known) Sensor at Near (paused, not counted as supply)'), text.join('\n'))

    return true
  })

  add('nulls: a class mount count that is not known leaves the component\'s need and shortage unknown, never 0', () => {
    const result = run({ parts: { ...PARTS, 2: [ENGINE(1), SENSOR(null)] } })
    const sensor = rowOf(result, 102)

    assert.equal(sensor.needed, null)
    assert.equal(sensor.net, null)
    assert.equal(sensor.netBasis, 'not known')
    assert.equal(result.totals.net, null)
    assert.equal(result.totals.netKnown, rowOf(result, 101).net + rowOf(result, 103).net)

    return true
  })

  const REMOTE_ENGINES = { 2: { 101: 20 } }
  const UNKNOWN_DEMAND = { ...PARTS, 2: [ENGINE(null)] }

  add('unknowndemand: a component whose mount count is not known leaves the totals that depend on it not known (net shortage, units and tons to move), with the known part beside them, and no usage or transport of its own is 0', () => {
    const result = run({ parts: { 1: [ARMOUR(4)], 2: [ENGINE(null)] }, stock: REMOTE_ENGINES })
    const engine = rowOf(result, 101)

    assert.equal(engine.needed, null)
    assert.deepEqual(engine.used, { stockLocal: null, stockRemote: null, queuedLocal: null, queuedRemote: null })
    assert.deepEqual([result.totals.needed, result.totals.net, result.totals.units, result.totals.tons], [null, null, null, null])
    assert.deepEqual([result.totals.neededKnown, result.totals.netKnown, result.totals.unitsKnown, result.totals.tonsKnown], [8, 8, 0, 0])
    assert.equal(result.totals.netProject, null)
    assert.equal(result.totals.netHull, 8)

    const known = run({ parts: { 1: [ARMOUR(4)] }, stock: REMOTE_ENGINES })

    assert.deepEqual([known.totals.needed, known.totals.net, known.totals.units, known.totals.tons], [8, 8, 0, 0])

    return true
  })

  add('unknowndemand: the export leaves the usage, the transport and the totals of a component whose mount count is not known as empty cells, never 0', () => {
    const result = run({ parts: UNKNOWN_DEMAND, stock: REMOTE_ENGINES })
    const record = recordsOf(pm.manifestCsv(result)).find((entry) => entry.Record === 'component' && entry['Component ID'] === '101')
    const line = pm.manifestText(result).split('\n').find((entry) => entry.startsWith('Engine (ID 101)'))

    assert.deepEqual([record.Needed, record['Used here'], record['Used elsewhere'], record['Used from queue here'], record['Used from queue elsewhere'], record['Units to move'], record['Tons to move'], record['Net shortage'], record['Spare stock']], ['', '', '', '', '', '', '', '', ''])
    assert.equal(record['Stock elsewhere'], '20')
    assert.ok(line.includes('needed not known'), line)
    assert.ok(line.includes('net shortage not known'), line)

    return true
  })

  add('unknowndemand: a component that is not short and one that is not needed keep their zeros (a real 0 stays 0)', () => {
    const record = recordsOf(pm.manifestCsv(run())).find((entry) => entry.Record === 'component' && entry['Component ID'] === '101')

    assert.deepEqual([record['Used from queue here'], record['Net shortage'], record['Units to move']], ['0', '0', '3'])

    return true
  })

  const MIXED_CLAIMS = [{ populationId: 3, componentId: 101, units: 3 }, { populationId: 3, componentId: 101, units: '' }]

  add('claims: a claim that is not known beside a proven one keeps the proven part (capped by the stock) and holds back only the rest as uncertain, leaving nothing available there; the export and the text say the same', () => {
    const result = run({ stock: withStock({ 3: { 101: 10 } }), entered: MIXED_CLAIMS })
    const engine = rowOf(result, 101)

    assert.deepEqual(engine.reserved, { proven: 3, unknown: 7 })
    assert.deepEqual([engine.available.known.local, engine.available.known.remote], [3, 10])
    assert.equal(engine.reserved.proven + engine.reserved.unknown + engine.available.known.local + engine.available.known.remote, engine.stock.local + engine.stock.remote)

    const capped = rowOf(run({ stock: withStock({ 3: { 101: 2 } }), entered: MIXED_CLAIMS }), 101)

    assert.deepEqual(capped.reserved, { proven: 2, unknown: 0 })

    const record = recordsOf(pm.manifestCsv(result)).find((entry) => entry.Record === 'component' && entry['Component ID'] === '101')
    const line = pm.manifestText(result).split('\n').find((entry) => entry.startsWith('Engine (ID 101)'))

    assert.deepEqual([record['Reserved (proven)'], record['Held back (claim not known)']], ['3', '7'])
    assert.ok(line.includes('held back 3 proven, 7 by a claim not known'), line)

    return true
  })

  add('alien: a component the race has not researched is a stock-required route, not built with the hull: what is short of it is not available, listed apart from the hull-built armour and the projects, in the totals, the export and the text', () => {
    const result = run({ parts: ALIEN_PARTS, stock: { 2: { 101: 1 } } })
    const engine = rowOf(result, 101)

    assert.equal(engine.route, 'stock')
    assert.equal(engine.needed, 6)
    assert.equal(engine.net, 5)
    assert.equal(engine.shortBP, null)
    assert.equal(rowOf(result, 103).route, 'hull')
    assert.equal(rowOf(result, 102).route, 'project')
    assert.deepEqual([result.totals.netStock, result.totals.netHull, result.totals.netProject, result.totals.net], [5, 8, 8, 21])

    const record = recordsOf(pm.manifestCsv(result)).find((entry) => entry.Record === 'component' && entry['Component ID'] === '101')
    const line = pm.manifestText(result).split('\n').find((entry) => entry.startsWith('Engine (ID 101)'))

    assert.equal(record.Route, 'stock required (not researched by the race)')
    assert.equal(record['Shortage BP'], '')
    assert.ok(line.includes('net shortage 5 (stock required'), line)
    assert.ok(!line.includes('built with the hull'), line)

    return true
  })

  add('alien: the research state decides the stock requirement whatever the other flags say: researched 0 is stock required with a prototype, a civilian line or a flag not stored, and one whose research is not known has a route not known, never the hull', () => {
    const variants = [{ prototype: 1 }, { prototype: null }, { shippingLine: 1 }, { shippingLine: null }, { prototype: null, shippingLine: null }, { obsolete: null }]

    for (const extra of variants) {
      const result = run({ parts: { ...PARTS, 1: [part(101, 'Engine', 1, 2, 10, { researched: 0, ...extra }), SENSOR(1), ARMOUR(4)] }, stock: { 2: { 101: 1 } } })
      const engine = rowOf(result, 101)
      const record = recordsOf(pm.manifestCsv(result)).find((entry) => entry.Record === 'component' && entry['Component ID'] === '101')

      assert.equal(engine.route, 'stock', JSON.stringify(extra))
      assert.equal(engine.shortBP, null, JSON.stringify(extra))
      assert.equal(result.totals.netHull, rowOf(result, 103).net, JSON.stringify(extra))
      assert.equal(record.Route, 'stock required (not researched by the race)', JSON.stringify(extra))
      assert.ok(!pm.manifestText(result).split('\n').find((line) => line.startsWith('Engine (ID 101)')).includes('built with the hull'), JSON.stringify(extra))
    }

    const armour = rowOf(run({ parts: { ...PARTS, 1: [ENGINE(2), SENSOR(1), part(103, 'Armour', 11, 4, 10, { researched: 0 })] } }), 103)

    assert.equal(armour.route, 'stock')

    for (const researched of [null, undefined]) {
      const unknown = rowOf(run({ parts: { ...PARTS, 1: [ENGINE(2), SENSOR(1), part(103, 'Armour', 11, 4, 10, { researched })] } }), 103)

      assert.equal(unknown.route, 'unknown')
    }

    const covered = run({ parts: ALIEN_PARTS, stock: { 1: { 101: 10 } } })

    assert.equal(rowOf(covered, 101).route, 'stock')
    assert.equal(rowOf(covered, 101).net, 0)
    assert.equal(rowOf(run({ parts: { ...PARTS, 1: [part(101, 'Engine', 1, 2, 10, { prototype: 1 }), SENSOR(1), ARMOUR(4)] } }), 101).route, 'hull')

    return true
  })

  add('transport: tons to move are the units times the tons a unit weighs in the design data, and unknown where the size is not known', () => {
    const result = run()

    assert.deepEqual(result.moves.map((move) => [move.componentId, move.populationId, move.units, move.tons]), [[101, 3, 3, 150], [102, 3, 2, 200], [102, 2, 5, 500]])
    assert.equal(result.totals.units, 10)
    assert.equal(result.totals.tons, 850)
    assert.equal(result.moves[0].colonyName, 'Near')
    assert.equal(result.moves[0].componentName, 'Engine')

    const unknown = run({ components: { 101: { tons: 50 }, 103: { tons: 25 } } })

    assert.deepEqual(unknown.moves.map((move) => move.tons), [150, null, null])
    assert.equal(unknown.totals.tons, null)

    return true
  })

  add('transport: nothing is moved for stock already at the colony, and the build colony itself is never a source', () => {
    const result = run({ stock: { 1: { 101: 20, 102: 20 } } })

    assert.deepEqual(result.moves, [])
    assert.equal(result.totals.units, 0)
    assert.equal(rowOf(result, 101).net, 0)

    return true
  })

  add('csv: the export has a record for each plan, component, transport and claim, with available, held back, queued and net shortage in columns of their own and local apart from remote stock', () => {
    const result = run({ projects: [project()], entered: [{ populationId: 2, componentId: 102, units: 2 }], tasks: [{ id: 1, populationId: 3, typeId: 4, classId: 1, refitId: 2, useComponents: 1 }] })
    const text = pm.manifestCsv(result)
    const [header] = parseCsv(text)
    const records = recordsOf(text)
    const kinds = new Set(records.map((record) => record.Record))
    const sensor = records.find((record) => record.Record === 'component' && record['Component ID'] === '102')

    assert.deepEqual(header, pm.CSV_COLUMNS)
    assert.deepEqual([...kinds].sort(), ['component', 'context', 'manufacture', 'plan', 'reservation', 'transport'])
    assert.equal(records.filter((record) => record.Record === 'component').length, 3)
    assert.equal(records.filter((record) => record.Record === 'plan').length, 5)
    assert.deepEqual([sensor['Stock here'], sensor['Stock elsewhere'], sensor['Reserved (proven)'], sensor['Held back (claim not known)'], sensor['Available here'], sensor['Available elsewhere']], ['0', '7', '2', '2', '0', '3'])
    assert.deepEqual([sensor['Queued here'], sensor['Queued elsewhere'], sensor['Queued paused']], ['5', '0', '0'])
    assert.deepEqual([sensor['Used here'], sensor['Used elsewhere'], sensor['Used from queue here'], sensor['Net shortage'], sensor['Net shortage basis']], ['0', '3', '5', '0', 'exact'])

    return true
  })

  add('csv: an unknown figure is an empty cell, never 0, and a name with a comma or a quote reads back whole', () => {
    const colonies = { ...COLONIES, 3: { ...COLONIES[3], name: 'Near, "the" one' } }
    const text = pm.manifestCsv(run({ parts: { ...PARTS, 2: [ENGINE(1), SENSOR(null)] }, components: { 101: { tons: null } }, colonies }))
    const records = recordsOf(text)
    const sensor = records.find((record) => record.Record === 'component' && record['Component ID'] === '102')
    const engine = records.find((record) => record.Record === 'component' && record['Component ID'] === '101')
    const transport = records.find((record) => record.Record === 'transport')

    assert.deepEqual([sensor.Needed, sensor['Net shortage'], sensor['Shortage BP'], sensor['Net shortage basis']], ['', '', '', 'not known'])
    assert.equal(engine['Tons to move'], '')
    assert.equal(transport.Colony, 'Near, "the" one')
    assert.equal(transport['Tons to move'], '')
    assert.ok(records.every((record) => Object.values(record).length === pm.CSV_COLUMNS.length))

    return true
  })

  add('csv: a name that starts like a formula is written so that a spreadsheet does not run it, and loses nothing', () => {
    const colonies = { ...COLONIES, 3: { ...COLONIES[3], name: '=HYPERLINK("x")' } }
    const records = recordsOf(pm.manifestCsv(run({ colonies })))
    const cells = records.map((record) => record.Colony).filter((value) => value.includes('HYPERLINK'))

    assert.ok(cells.length > 0)
    assert.ok(cells.every((value) => !/^[=+\-@\t\r]/.test(value) && value.includes('=HYPERLINK("x")')))
    assert.ok(records.every((record) => Object.values(record).every((value) => !/^[=+\-@\t\r]/.test(value))))

    return true
  })

  add('csv: the transport record names the colony the units come from and the component, and the copied text says the same', () => {
    const result = run()
    const records = recordsOf(pm.manifestCsv(result))
    const move = records.find((record) => record.Record === 'transport' && record['Component ID'] === '102' && record['Colony ID'] === '2')
    const text = pm.manifestText(result)

    assert.deepEqual([move.Colony, move.Component, move['Units to move'], move['Tons to move'], move.System], ['Far', 'Sensor', '5', '500', 'Away'])
    assert.ok(text.includes('Move 5 Sensor from Far, 500 t'), text)
    assert.ok(text.includes('Move 3 Engine from Near'), text)
    assert.ok(text.includes('Sensor (ID 102): needed 8;'), text)

    return true
  })

  add('csv: the copied text names an upper bound as "at most" and lists what is not known', () => {
    const text = pm.manifestText(run({ tasksRead: false }))

    assert.ok(text.includes('net shortage at most 8'), text)
    assert.ok(text.includes('Not known:'), text)

    return true
  })

  add('invalid: hulls that are not a whole number of 1 or more, no plan and no colony give no manifest', () => {
    for (const hulls of [0, 1.5, null, NaN, -2]) {
      assert.ok(typeof run({ plans: [{ ...PLAN_ALPHA, hulls }] }).invalid === 'string', `${hulls} accepted`)
    }

    assert.ok(typeof run({ plans: [] }).invalid === 'string')
    assert.ok(typeof run({ targetId: null }).invalid === 'string')
    assert.equal(run().invalid, null)

    return true
  })

  add('invalid: a class that mounts nothing is reported and does not fail the manifest', () => {
    const result = run({ plans: [{ ...PLAN_ALPHA, classId: 5, className: 'Empty' }, PLAN_BETA] })

    assert.deepEqual(result.problems, ['Empty mounts no component'])
    assert.equal(result.rows.length, 2)

    return true
  })

  add('target: the colony the hulls are needed at by default is the one with a shipyard that holds the most of what the plans need', () => {
    const plans = [PLAN_ALPHA, PLAN_BETA]
    const noYards = Object.fromEntries(Object.values(COLONIES).map((colony) => [colony.id, { ...colony, yards: null }]))

    assert.equal(pm.defaultTarget({ plans, parts: PARTS, stock: STOCK, colonies: COLONIES }).id, 1)
    assert.equal(pm.defaultTarget({ plans, parts: PARTS, stock: STOCK, colonies: { ...COLONIES, 2: { ...COLONIES[2], yards: 2 } } }).id, 2)
    assert.equal(pm.defaultTarget({ plans, parts: PARTS, stock: STOCK, colonies: noYards }).id, 2)
    assert.equal(pm.defaultTarget({ plans, parts: PARTS, stock: STOCK, colonies: {} }), null)

    return true
  })

  return statements
}

// ---------- the reads on a database of their own ----------

const TABLES = {
  FCT_Population: ['PopulationID', 'GameID', 'RaceID', 'PopName', 'SystemID'],
  FCT_RaceSysSurvey: ['SystemID', 'RaceID', 'Name'],
  FCT_Shipyard: ['ShipyardID', 'GameID', 'PopulationID'],
  FCT_ShipClass: ['ShipClassID', 'Cost'],
  FCT_ShipyardTask: ['TaskID', 'GameID', 'RaceID', 'PopulationID', 'TaskTypeID', 'ClassID', 'RefitID', 'Paused', 'UseComponents', 'TotalBP', 'CompletedBP'],
  FCT_IndustrialProjects: ['ProjectID', 'GameID', 'RaceID', 'PopulationID', 'ProductionType', 'ProductionID', 'Amount', 'PartialCompletion', 'Percentage', 'Queue', 'Description', 'Pause'],
  FCT_ShipDesignComponents: ['SDComponentID', 'GameID', 'Name', 'ComponentTypeID', 'Size', 'Cost'],
  FCT_RaceTech: ['GameID', 'TechID', 'RaceID'],
}

const FIXTURE_ROWS = {
  FCT_Population: [
    { PopulationID: 1, GameID: 1, RaceID: 1, PopName: 'Alpha', SystemID: 10 },
    { PopulationID: 2, GameID: 1, RaceID: 1, PopName: 'Beta', SystemID: 10 },
    { PopulationID: 3, GameID: 1, RaceID: 2, PopName: 'Other race', SystemID: 10 },
    { PopulationID: 4, GameID: 1, RaceID: 1, PopName: 'No survey', SystemID: 99 },
    { PopulationID: 5, GameID: 2, RaceID: 1, PopName: 'Other game', SystemID: 10 },
    { PopulationID: 6, GameID: 1, RaceID: 1, PopName: 'Unsurveyed', SystemID: 20 },
  ],
  FCT_RaceSysSurvey: [
    { SystemID: 10, RaceID: 1, Name: 'Sol' },
    { SystemID: 10, RaceID: 2, Name: 'Other name' },
    { SystemID: 20, RaceID: 2, Name: 'Foreign name' },
  ],
  FCT_Shipyard: [
    { ShipyardID: 1, GameID: 1, PopulationID: 1 },
    { ShipyardID: 2, GameID: 1, PopulationID: 1 },
    { ShipyardID: 3, GameID: 2, PopulationID: 1 },
  ],
  FCT_ShipClass: [{ ShipClassID: 5, Cost: 100 }],
  FCT_ShipyardTask: [
    { TaskID: 1, GameID: 1, RaceID: 1, PopulationID: 1, TaskTypeID: 0, ClassID: 5, RefitID: 0, Paused: 1, UseComponents: 1, TotalBP: 90, CompletedBP: 0 },
    { TaskID: 2, GameID: 1, RaceID: 2, PopulationID: 3, TaskTypeID: 0, ClassID: 5, RefitID: 0, Paused: 0, UseComponents: 1, TotalBP: 100, CompletedBP: 0 },
    { TaskID: 3, GameID: 1, RaceID: 1, PopulationID: 2, TaskTypeID: 4, ClassID: 5, RefitID: 6, Paused: null, UseComponents: null, TotalBP: null, CompletedBP: null },
  ],
  FCT_IndustrialProjects: [
    { ProjectID: 1, GameID: 1, RaceID: 1, PopulationID: 1, ProductionType: 3, ProductionID: 102, Amount: 4.0268, PartialCompletion: 0.9732, Percentage: 2, Queue: 0, Description: 'Sensor', Pause: 0 },
    { ProjectID: 2, GameID: 1, RaceID: 1, PopulationID: 1, ProductionType: 0, ProductionID: 500, Amount: 7, PartialCompletion: 0, Percentage: 5, Queue: 1, Description: 'A ship', Pause: 0 },
    { ProjectID: 3, GameID: 1, RaceID: 2, PopulationID: 3, ProductionType: 3, ProductionID: 101, Amount: 2, PartialCompletion: 0, Percentage: 5, Queue: 0, Description: 'Other race engine', Pause: 0 },
    { ProjectID: 4, GameID: 1, RaceID: 1, PopulationID: 2, ProductionType: 3, ProductionID: 101, Amount: null, PartialCompletion: 0.5, Percentage: 5, Queue: 1, Description: 'Engine', Pause: null },
  ],
  FCT_ShipDesignComponents: [
    { SDComponentID: 101, GameID: 0, Name: 'Engine', ComponentTypeID: 1, Size: 2, Cost: 50 },
    { SDComponentID: 102, GameID: 0, Name: 'Sensor', ComponentTypeID: 2, Size: null, Cost: 100 },
    { SDComponentID: 103, GameID: 0, Name: 'Not researched', ComponentTypeID: 11, Size: 0.5, Cost: 10 },
  ],
  FCT_RaceTech: [
    { GameID: 1, TechID: 101, RaceID: 1 },
    { GameID: 1, TechID: 102, RaceID: 1 },
    { GameID: 1, TechID: 103, RaceID: 2 },
  ],
}

const allRows = (raw, sql, parameters = {}) => new Promise((resolve, reject) => raw.all(sql, parameters, (error, rows) => (error ? reject(error) : resolve([rows]))))

const runSql = (raw, sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))

// The application's database object over a sqlite handle: `query(sql, { replacements })` resolves [rows], with the named replacements bound.
const queryOf = (raw) => (sql, options = {}) => allRows(raw, sql, Object.fromEntries(Object.entries(options.replacements || {}).map(([name, value]) => [`:${name}`, value])))

// An in-memory database with the tables above (those named in `without` as 'Table' or 'Table.Column' left out).
const fixtureDatabase = (without = []) => new Promise((resolve, reject) => {
  const raw = new sqlite3.Database(':memory:')
  const columnsOf = (table) => TABLES[table].filter((column) => !without.includes(`${table}.${column}`))
  const tables = Object.keys(TABLES).filter((table) => !without.includes(table))

  raw.serialize(() => {
    tables.forEach((table) => {
      raw.run(`create table ${table} (${columnsOf(table).join(', ')})`)
      ;(FIXTURE_ROWS[table] || []).forEach((row) => {
        const columns = columnsOf(table)

        raw.run(`insert into ${table} (${columns.join(', ')}) values (${columns.map(() => '?').join(', ')})`, columns.map((column) => row[column] === undefined ? null : row[column]))
      })
    })
    raw.get('select 1', (error) => (error ? reject(error) : resolve({ query: queryOf(raw), close: () => raw.close() })))
  })
})

const loaders = (ctx) => {
  const { m } = ctx
  const data = m['procurement-data']
  const scope = { GameID: 1, RaceID: 1 }
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const read = async (without = []) => {
    const db = await fixtureDatabase(without)

    try {
      return await data.loadProcurementSources(db, scope)
    } finally {
      db.close()
    }
  }

  add('loaders: the colonies are the race\'s in the game, with the name of the system from the race\'s own survey and a count of their shipyards in the game', async () => {
    const sources = await read()

    assert.deepEqual(Object.keys(sources.colonies).map(Number), [1, 2, 4, 6])
    assert.equal(sources.colonies[6].systemName, null)
    assert.deepEqual(sources.colonies[1], { id: 1, name: 'Alpha', systemId: 10, systemName: 'Sol', yards: 2 })
    assert.equal(sources.colonies[2].yards, 0)
    assert.equal(sources.colonies[4].systemName, null)
    assert.equal(sources.read.colonies, true)

    return true
  })

  add('loaders: the tasks are the race\'s, one row each with the class cost; a column that is null in the row is unknown, never 0', async () => {
    const { tasks, read: reads } = await read()

    assert.deepEqual(tasks.map((task) => task.id), [1, 3])
    assert.deepEqual([tasks[0].typeId, tasks[0].classId, tasks[0].totalBP, tasks[0].classCost, tasks[0].paused, tasks[0].useComponents], [0, 5, 90, 100, 1, 1])
    assert.deepEqual([tasks[1].typeId, tasks[1].refitId, tasks[1].useComponents, tasks[1].totalBP, tasks[1].paused], [4, 6, null, null, null])
    assert.equal(tasks[1].classCost, 100)
    assert.equal(reads.tasks, true)

    return true
  })

  add('loaders: the projects are the race\'s component projects only (production type 3), with the remaining amount, the part-built unit and the pause flag as stored', async () => {
    const { projects } = await read()

    assert.deepEqual(projects.map((entry) => entry.id), [1, 4])
    assert.deepEqual([projects[0].componentId, projects[0].populationId, projects[0].amount, projects[0].partial, projects[0].paused, projects[0].name], [102, 1, 4.0268, 0.9732, 0, 'Sensor'])
    assert.deepEqual([projects[1].amount, projects[1].paused], [null, null])

    return true
  })

  add('loaders: the tons of a component come from the design data\'s size (2 HS = 100 t); a size that is not known is null, and a component the race has not researched is left out', async () => {
    const { components, read: reads } = await read()

    assert.deepEqual(Object.keys(components).map(Number), [101, 102])
    assert.equal(components[101].tons, 100)
    assert.equal(components[102].tons, null)
    assert.equal(components[101].name, 'Engine')
    assert.equal(reads.components, true)

    return true
  })

  add('loaders: a column the save lacks is unknown, not 0 (no pause flag, no cost of a class, no shipyard table, no survey)', async () => {
    const noPause = await read(['FCT_IndustrialProjects.Pause'])
    const noClassCost = await read(['FCT_ShipClass.Cost'])
    const noYards = await read(['FCT_Shipyard'])
    const noSurvey = await read(['FCT_RaceSysSurvey'])
    const noAmounts = await read(['FCT_IndustrialProjects.Amount', 'FCT_IndustrialProjects.PartialCompletion'])
    const noUse = await read(['FCT_ShipyardTask.UseComponents'])

    assert.deepEqual(noPause.projects.map((entry) => entry.paused), [null, null])
    assert.deepEqual(noClassCost.tasks.map((task) => task.classCost), [null, null])
    assert.equal(noYards.colonies[1].yards, null)
    assert.equal(noSurvey.colonies[1].systemName, null)
    assert.deepEqual(noAmounts.projects.map((entry) => [entry.amount, entry.partial]), [[null, null], [null, null]])
    assert.deepEqual(noUse.tasks.map((task) => task.useComponents), [null, null])

    return true
  })

  add('loaders: a table the save lacks says it was not read (tasks, projects, colonies), never an empty read', async () => {
    const noTasks = await read(['FCT_ShipyardTask'])
    const noProjects = await read(['FCT_IndustrialProjects'])
    const noColonies = await read(['FCT_Population'])
    const noType = await read(['FCT_ShipyardTask.TaskTypeID'])
    const noProduction = await read(['FCT_IndustrialProjects.ProductionID'])

    assert.deepEqual([noTasks.read.tasks, noTasks.tasks], [false, []])
    assert.deepEqual([noProjects.read.projects, noProjects.projects], [false, []])
    assert.deepEqual([noColonies.read.colonies, noColonies.colonies], [false, {}])
    assert.equal(noType.read.tasks, false)
    assert.equal(noProduction.read.projects, false)

    return true
  })

  add('registry: the reads of the page declare the size and the cost of the components, so that a save without them is unsupported and the page is held back, not shown with the tons of every unit unknown', () => {
    const entry = m.capabilities.INPUTS['/production'].find((input) => input.key === 'procurementSources')

    assert.ok(entry, 'the read is not an input of the page')
    assert.ok(entry.reads.FCT_ShipDesignComponents, 'the components are not read')
    assert.ok(entry.reads.FCT_ShipDesignComponents.includes('Size'), 'no Size')
    assert.ok(entry.reads.FCT_ShipDesignComponents.includes('Cost'), 'no Cost')
    assert.equal(entry.optional, false)

    return true
  })

  add('loaders: the default says nothing was read', () => {
    assert.deepEqual(data.NO_PROCUREMENT_SOURCES.read, { colonies: false, tasks: false, projects: false, components: false })
    assert.equal(data.COMPONENT_PROJECT, 3)

    return true
  })

  return statements
}

// ---------- the component and the page ----------

const COMPONENT_NAME = 'components/production/ProcurementManifest'

const STORE = { $store: { getters: { 'capabilities/blockedBonuses': new Set() }, state: {}, dispatch: async () => {} } }

const SOURCES = { classes: [{ id: 1, name: 'Alpha', obsolete: false }, { id: 2, name: 'Beta', obsolete: false }], parts: PARTS, stock: STOCK, minerals: {} }

const PROCUREMENT = { colonies: COLONIES, tasks: [], projects: [], components: COMPONENTS, read: { colonies: true, tasks: true, projects: true, components: true } }

const componentOf = (ctx, over = {}) => instantiate(ctx.componentOptions, { ...STORE, data: { sources: SOURCES, procurement: PROCUREMENT, plans: [{ id: 1, classId: 1, hulls: '2' }, { id: 2, classId: 2, hulls: '2' }], chosenTarget: 1, entered: [], message: '', headers: [], moveHeaders: [], ...over } })

const components = (ctx) => {
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const pm = ctx.m['procurement-manifest']

  add('component: the manifest of the page is the utility\'s on the plans as typed, the sources the page read and the colony chosen', () => {
    const vm = componentOf(ctx)
    const expected = pm.reconcile(input())

    assert.deepEqual(vm.manifest.rows.map((row) => [row.componentId, row.needed, row.net]), expected.rows.map((row) => [row.componentId, row.needed, row.net]))
    assert.equal(vm.exportable, true)
    assert.deepEqual(vm.moveRows.map((row) => row.key), ['101-3-stock', '102-3-stock', '102-2-stock'])
    assert.deepEqual(vm.moveRows.map((row) => row.tons), [150, 200, 500])

    return true
  })

  add('component: the plans are served in the order listed', () => {
    const vm = componentOf(ctx, { plans: [{ id: 2, classId: 2, hulls: '2' }, { id: 1, classId: 1, hulls: '2' }] })
    const sensor = vm.manifest.rows.find((row) => row.componentId === 102)

    assert.deepEqual(sensor.perPlan.map((entry) => entry.planId), [2, 1])
    assert.deepEqual(sensor.perPlan.map((entry) => entry.short), [0, 1])

    return true
  })

  add('component: hulls typed as anything but a whole number of 1 or more give no manifest and no export, and name the plan', () => {
    for (const hulls of ['', '  ', '0', '1.5', 'x', '-1']) {
      const vm = componentOf(ctx, { plans: [{ id: 1, classId: 1, hulls }] })

      assert.ok(typeof vm.manifest.invalid === 'string', `"${hulls}" accepted`)
      assert.equal(vm.exportable, false)
      assert.deepEqual(vm.invalidPlans, [1])
    }

    return true
  })

  add('unknowndemand: the panel shows the net shortage and what has to move as not known, with the known part in the note, never 0; the usage cell says not known', () => {
    const vm = componentOf(ctx, { sources: { ...SOURCES, parts: { 1: [ARMOUR(4)], 2: [ENGINE(null)] }, stock: { 2: { 101: 20 } } }, procurement: { ...PROCUREMENT, colonies: COLONIES } })
    const tile = (label) => vm.tiles.find((entry) => entry.label === label)

    assert.equal(tile('Net shortage').value, vm.figure(null))
    assert.ok(tile('Net shortage').note.includes('8 short'), tile('Net shortage').note)
    assert.equal(tile('To move').value, 'Not known')
    assert.ok(tile('To move').note.includes('0 units'), tile('To move').note)

    const known = componentOf(ctx)

    assert.equal(known.tiles.find((entry) => entry.label === 'To move').value, '10 units')

    return true
  })

  add('alien: the panel names a stock-required component as such and lists what is not available apart in the shortage note', () => {
    const vm = componentOf(ctx, { sources: { ...SOURCES, parts: ALIEN_PARTS, stock: { 2: { 101: 1 } } } })

    assert.equal(vm.routeText(vm.manifest.rows.find((row) => row.componentId === 101)), 'stock required, not researched by the race')
    assert.ok(vm.tiles.find((entry) => entry.label === 'Net shortage').note.includes('5 not available (stock required)'))

    return true
  })

  add('component: the tasks, the projects and whether they were read reach the manifest (a task list that was not read holds all the stock back, a project is supply)', () => {
    const tasks = [{ id: 1, populationId: 3, typeId: 4, classId: 1, refitId: 2, useComponents: 1 }]
    const refit = componentOf(ctx, { procurement: { ...PROCUREMENT, tasks } })
    const unread = componentOf(ctx, { procurement: { ...PROCUREMENT, read: { ...PROCUREMENT.read, tasks: false } } })
    const queued = componentOf(ctx, { procurement: { ...PROCUREMENT, projects: [project()] } })
    const unreadQueue = componentOf(ctx, { procurement: { ...PROCUREMENT, read: { ...PROCUREMENT.read, projects: false } } })
    const sensorOf = (vm) => vm.manifest.rows.find((row) => row.componentId === 102)

    assert.equal(sensorOf(refit).reserved.unknown, 2)
    assert.equal(sensorOf(unread).netBasis, 'at most')
    assert.equal(sensorOf(unread).net, 8)
    assert.equal(sensorOf(queued).net, 0)
    assert.equal(sensorOf(unreadQueue).netBasis, 'at most')

    return true
  })

  add('component: a hand entry that is blank or not a number holds back all the stock; one of 0 or more holds back that many', () => {
    const sensorOf = (vm) => vm.manifest.rows.find((row) => row.componentId === 102)
    const blank = componentOf(ctx, { entered: [{ id: 9, populationId: 2, componentId: 102, units: '' }] })
    const some = componentOf(ctx, { entered: [{ id: 9, populationId: 2, componentId: 102, units: '2' }] })

    assert.deepEqual(sensorOf(blank).reserved, { proven: 0, unknown: 5 })
    assert.equal(blank.enteredValid({ units: '' }), false)
    assert.deepEqual(sensorOf(some).reserved, { proven: 2, unknown: 0 })
    assert.equal(some.enteredValid({ units: '0' }), true)
    assert.equal(some.enteredValid({ units: '-1' }), false)

    return true
  })

  add('component: the colony chosen is used, else the default one; a colony the save does not have is not used', () => {
    assert.equal(componentOf(ctx, { chosenTarget: 3 }).targetId, 3)
    assert.equal(componentOf(ctx, { chosenTarget: null }).targetId, 1)
    assert.equal(componentOf(ctx, { chosenTarget: 77 }).targetId, 1)
    assert.equal(componentOf(ctx, { chosenTarget: 3 }).manifest.target.name, 'Near')

    return true
  })

  add('manufacture: the panel lists each manufacturing location once, keyed by component, colony and state, with the paused one apart', () => {
    const vm = componentOf(ctx, { procurement: { ...PROCUREMENT, projects: [project({ populationId: 1, amount: 1.5, partial: 0.5 }), project({ id: 2, populationId: 2, amount: 8, partial: 0 }), project({ id: 3, populationId: 3, amount: 7, partial: 0, paused: 1 })] } })

    assert.deepEqual(vm.manufactureRows.map((row) => row.key), ['102-1-queued', '102-2-queued', '102-3-paused'])
    assert.deepEqual(vm.manufactureRows.map((row) => [row.units, row.used, row.unused]), [[2, 1, 1], [8, 0, 8], [7, null, null]])
    assert.deepEqual(componentOf(ctx).manufactureRows, [])

    return true
  })

  add('queueunknown: the panel lists a project with no remaining amount at its colony with its units not known, and the queued cells say not known with the known part beside it', () => {
    const vm = componentOf(ctx, { procurement: { ...PROCUREMENT, projects: [project({ id: 5, populationId: 2, amount: null }), project({ id: 6, populationId: 3, amount: null, paused: 1 })] } })
    const sensor = vm.manifest.rows.find((row) => row.componentId === 102)

    assert.deepEqual(vm.manufactureRows.map((row) => [row.key, row.units, row.incomplete]), [['102-2-queued', null, true], ['102-3-paused', null, true]])
    assert.deepEqual([sensor.queued.local, sensor.queued.remote, sensor.queued.paused], [0, null, null])

    return true
  })

  return statements
}

const templates = (ctx) => {
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const text = ctx.componentText
  const page = ctx.pageText
  const summary = (text.match(/class="panel procurement-manifest" data-summary="([^"]*)"/) || [])[1]
  const foot = (text.match(/<div class="panel-foot caption text--secondary">([\s\S]*?)<\/div>/) || [])[1]
  const voice = /\b(I|me|my|mine|you|your|yours|we|our|ours)\b/i

  add('template: the panel is a top-level panel with a data-summary of a sentence or two and no figure that changes', () => {
    assert.ok(summary, 'no data-summary')
    assert.ok(summary.trim().length > 0)
    assert.ok(!/\d/.test(summary), `a figure in "${summary}"`)

    return true
  })

  add('template: the summary and the foot are impersonal (no I, you or we)', () => {
    assert.ok(foot && foot.trim().length > 0, 'no foot')
    assert.ok(!voice.test(summary), summary)
    assert.ok(!voice.test(foot), (foot.match(voice) || [])[0])
    assert.ok(!voice.test((text.match(/<template>[\s\S]*<\/template>/) || [''])[0].replace(/\{\{[^}]*\}\}/g, '').replace(/data-[a-z-]+="[^"]*"/g, '')))

    return true
  })

  add('template: both rules have their mark, the export has a CSV and a copy button, and an upper bound reads "at most"', () => {
    assert.ok(text.includes('<provenance-mark rule="production.procurementManifest" />'))
    assert.ok(text.includes('<provenance-mark rule="production.procurementReservations" />'))
    assert.ok(/data-manifest-csv @click="downloadCsv"/.test(text))
    assert.ok(/data-manifest-copy @click="copyText"/.test(text))
    assert.ok(text.includes('item.netBasis === \'at most\' ? \'at most \' : \'\''))
    assert.ok(text.includes('hide-default-footer'))

    return true
  })

  add('template: the table has each column the export separates (needed, stock here and elsewhere, held back, available, queued, used, net shortage) and a transport table', () => {
    for (const label of ["text: 'Needed'", "text: 'In stock here'", "text: 'In stock elsewhere'", "text: 'Held back'", "text: 'Available'", "text: 'Queued'", "text: 'Used'", "text: 'Net shortage'"]) {
      assert.ok(text.includes(label), label)
    }

    assert.ok(text.includes('data-manifest-moves'))
    assert.ok(text.includes('Transport to'))

    return true
  })

  add('template: the manufacturing locations have a table of their own, and a stock that is not known shows the units known beside it', () => {
    assert.ok(text.includes('data-manifest-manufacture'))
    assert.ok(text.includes('Manufacturing locations'))

    for (const label of ["text: 'Made at'", "text: 'State'", "text: 'Units'", "text: 'Used by the plans'", "text: 'Not used'"]) {
      assert.ok(text.includes(label), label)
    }

    assert.ok(text.includes('item.stock.local === null') && text.includes('item.stock.known.local'))
    assert.ok(text.includes('item.stock.remote === null') && text.includes('item.stock.known.remote'))

    return true
  })

  add('template: the usage cell of a component with no known need says not known, and the tiles show an unknown total as not known with the known part in the note', () => {
    assert.ok(text.includes("item.needed === null ? 'not known'"))
    assert.ok(text.includes('totals.net === null') && text.includes('totals.units === null'))

    return true
  })

  add('template: the queued cells and the manufacturing units show an amount that is not known as not known, with the known part beside it', () => {
    assert.ok(text.includes('item.queued.remote === null') && text.includes('item.queued.known.remote'))
    assert.ok(text.includes('item.queued.paused === null') && text.includes('item.queued.known.paused'))
    assert.ok(text.includes('item.incomplete') && text.includes("'not known'"))

    return true
  })

  add('page: the manifest is mounted on the Production page with the read of the page and its own, and the read is tracked and labelled under one name', () => {
    assert.ok(page.includes('<procurement-manifest :sources="componentSources" :procurement="procurementSources" />'))
    assert.ok(/components: \{[^}]*ProcurementManifest[^}]*\}/.test(page))
    assert.ok(/procurementSources: 'the shipyard tasks/.test(page), 'no label')
    assert.ok(/procurementSources: \{\n\s+get: tracked\('procurementSources'/.test(page), 'not tracked under its own name')
    assert.ok(page.includes('loadProcurementSources(this.database, { GameID: this.GameID, RaceID: this.RaceID })'))
    assert.ok(page.includes('default: NO_PROCUREMENT_SOURCES'))

    return true
  })

  return statements
}

// ---------- the saves ----------

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({ file: path.basename(resolved), query: queryOf(raw), overlay: (statements) => statements.reduce((chain, sql) => chain.then(() => runSql(raw, sql)), Promise.resolve()), close: () => raw.close() })
  })
})

const rowsOf = async (database, sql) => (await database.query(sql))[0]

const saveStatements = async (ctx, save) => {
  const { m, pageOptions } = ctx
  const database = await openSave(save.file)

  if (!database) {
    return { skipped: true, statements: [] }
  }

  const scope = { GameID: save.game, RaceID: save.race }
  const where = `GameID = ${save.game} and RaceID = ${save.race}`
  const pm = m['procurement-manifest']
  const data = m['procurement-data']
  const statements = []
  const label = (text) => `${text} (${save.file})`
  const add = (name, test) => statements.push([label(name), test])
  const pageOf = (db = database) => instantiate(pageOptions, { ...STORE, database: db, GameID: save.game, RaceID: save.race })
  const readsOf = async (db = database) => {
    const vm = pageOf(db)
    const [sources, procurement] = [await vm.runAsync('componentSources'), await vm.runAsync('procurementSources')]

    return { sources, procurement }
  }

  let cached = null
  const reads = async () => (cached = cached || await readsOf())

  add('save-counts: the reads are the rows of the save (colonies, tasks, component projects) and the colonies carry a system and a count of shipyards', async () => {
    const { procurement } = await reads()
    const [{ colonies }] = await rowsOf(database, `select count(*) as colonies from FCT_Population where ${where}`)
    const [{ tasks }] = await rowsOf(database, `select count(*) as tasks from FCT_ShipyardTask where ${where}`)
    const [{ projects }] = await rowsOf(database, `select count(*) as projects from FCT_IndustrialProjects where ${where} and ProductionType = 3`)
    const [{ yards }] = await rowsOf(database, `select count(*) as yards from FCT_Shipyard where ${where}`)

    assert.equal(Object.keys(procurement.colonies).length, colonies)
    assert.ok(colonies > 0)
    assert.equal(procurement.tasks.length, tasks)
    assert.equal(procurement.projects.length, projects)
    assert.equal(Object.values(procurement.colonies).reduce((sum, colony) => sum + colony.yards, 0), yards)
    assert.ok(Object.values(procurement.colonies).every((colony) => typeof colony.name === 'string' && Number.isInteger(colony.systemId) && typeof colony.systemName === 'string'))
    assert.deepEqual(procurement.read, { colonies: true, tasks: true, projects: true, components: true })

    return true
  })

  add('save-counts: the read of the page is the loader\'s on the same save', async () => {
    const { procurement } = await reads()
    const direct = await data.loadProcurementSources(database, scope)

    assert.deepEqual(procurement, direct)

    return true
  })

  add('save-ids: a queued project\'s ProductionID is a component of the race, its remaining amount and part-built unit are numbers, and its units are a whole number', async () => {
    const { procurement } = await reads()

    if (!procurement.projects.length) {
      return UNSUPPORTED
    }

    for (const entry of procurement.projects) {
      const [row] = await rowsOf(database, `select c.SDComponentID, c.Cost, p.ProdPerUnit from FCT_ShipDesignComponents c inner join FCT_IndustrialProjects p on p.ProductionID = c.SDComponentID where p.ProjectID = ${entry.id} and p.ProductionType = 3`)

      assert.ok(row, `project ${entry.id} names no component`)
      same(row.Cost, row.ProdPerUnit, `project ${entry.id} cost per unit`)
      assert.ok(Number.isFinite(entry.amount) && Number.isFinite(entry.partial))
      assert.ok(Number.isInteger(m['procurement-manifest'].projectUnits(entry)))
      assert.ok(Math.abs(m['procurement-manifest'].projectUnits(entry) - (entry.amount + entry.partial)) < 1e-3, `project ${entry.id} units ${m['procurement-manifest'].projectUnits(entry)} against ${entry.amount} + ${entry.partial}`)
    }

    return true
  })

  add('save-sources: the shared component read is read from the same save: each class mount count is the save\'s row and each component the race has researched costs what the design data says', async () => {
    const { sources, procurement } = await reads()
    const mounts = await rowsOf(database, `select ClassID, ComponentID, NumComponent from FCT_ClassComponent where GameID = ${save.game}`)
    const known = Object.values(sources.parts).flat()
    let compared = 0

    assert.ok(mounts.length > 0)
    assert.equal(known.length, mounts.filter((row) => sources.classes.some((entry) => entry.id === row.ClassID)).length, `parts ${known.length} against mounts`)

    for (const mount of mounts.filter((row) => sources.classes.some((entry) => entry.id === row.ClassID))) {
      assert.ok(sources.parts[mount.ClassID].some((entry) => entry.componentId === mount.ComponentID && entry.count === mount.NumComponent), `class ${mount.ClassID} component ${mount.ComponentID}`)
    }

    for (const entry of known) {
      const component = procurement.components[entry.componentId]

      if (component) {
        compared++
        assert.equal(component.name, entry.name, `name of ${entry.componentId}: ${component.name} / ${entry.name}`)
        assert.equal(component.typeId, entry.typeId, `type of ${entry.componentId}`)
        assert.ok(component.tons === null || component.tons >= 0)
      }
    }

    assert.ok(compared > 0, 'no mounted component is among the components the design data reads')

    return true
  })

  add('save-sources: the tons of a unit are the design data\'s (HS x 50), and the loader read as many components as the race has researched', async () => {
    const { procurement } = await reads()
    const [{ researched }] = await rowsOf(database, `select count(*) as researched from FCT_RaceTech t inner join FCT_ShipDesignComponents c on c.SDComponentID = t.TechID and (c.GameID = 0 or c.GameID = ${save.game}) where t.${where}`)
    const [sample] = await rowsOf(database, `select c.SDComponentID, c.Size, c.ComponentTypeID from FCT_RaceTech t inner join FCT_ShipDesignComponents c on c.SDComponentID = t.TechID and (c.GameID = 0 or c.GameID = ${save.game}) where t.${where} and c.ComponentTypeID = 1 and c.Size is not null limit 1`)

    assert.equal(Object.keys(procurement.components).length, researched)

    if (sample) {
      same(procurement.components[sample.SDComponentID].tons, sample.Size * 50, 'tons of an engine')
    }

    return true
  })

  add('save-tasks: the shipyard tasks of the race are read with their type, class and credit, and the reservations read from them are the ones the rules give (nothing held by a construction task)', async () => {
    const { sources, procurement } = await reads()

    if (!procurement.tasks.length) {
      return UNSUPPORTED
    }

    const reservations = pm.reservationsOf({ tasks: procurement.tasks, parts: sources.parts, read: true })
    const autoRefits = procurement.tasks.filter((task) => task.typeId === 4 && task.useComponents !== 0)
    const taken = procurement.tasks.filter((task) => task.typeId === 0 || task.typeId === 2)

    assert.equal(reservations.tasks.filter((task) => task.state === 'taken').length, taken.length)
    assert.ok(reservations.claims.every((claim) => claim.source === 'task' && claim.proof === 'unknown'))
    assert.ok(reservations.claims.length >= autoRefits.length)

    if (!autoRefits.length) {
      assert.deepEqual(reservations.claims, [])
    }

    assert.ok(procurement.tasks.every((task) => Number.isInteger(task.typeId) && Number.isInteger(task.populationId)))
    assert.ok(procurement.tasks.every((task) => task.classCost === null || task.classCost >= 0))

    return true
  })

  add('save-manifest: the manifest of every pair of real classes allocates each unit of stock and each queued unit once, with the figures adding up', async () => {
    const { sources, procurement } = await reads()
    const classes = sources.classes.filter((entry) => (sources.parts[entry.id] || []).length > 0).slice(0, 8)

    if (classes.length < 2) {
      return UNSUPPORTED
    }

    let pairs = 0

    for (let first = 0; first < classes.length; first++) {
      for (let second = first; second < classes.length; second++) {
        const plans = [{ id: 1, classId: classes[first].id, className: classes[first].name, hulls: 3 }, { id: 2, classId: classes[second].id, className: classes[second].name, hulls: 2 }]
        const targetId = pm.defaultTarget({ plans, parts: sources.parts, stock: sources.stock, colonies: procurement.colonies }).id
        const result = pm.reconcile({ plans, parts: sources.parts, stock: sources.stock, colonies: procurement.colonies, targetId, projects: procurement.projects, projectsRead: true, tasks: procurement.tasks, tasksRead: true, components: procurement.components })

        pairs++
        assert.equal(result.invalid, null)

        for (const row of result.rows) {
          const stock = row.stock.local + row.stock.remote
          const usedStock = row.used.stockLocal + row.used.stockRemote
          const usedQueued = row.used.queuedLocal + row.used.queuedRemote

          assert.ok(usedStock <= stock + 1e-9, `${row.name}: more stock used than held`)
          assert.ok(usedQueued <= row.queued.local + row.queued.remote + 1e-9, `${row.name}: more queued units used than queued`)
          assert.ok(row.available.local >= -1e-9 && row.available.remote >= -1e-9, `${row.name}: negative availability`)
          same(row.reserved.proven + row.reserved.unknown + row.available.local + row.available.remote, stock, `${row.name} stock split`)

          if (row.needed !== null) {
            same(row.net, row.needed - usedStock - usedQueued, `${row.name} net`)
            same(row.perPlan.reduce((sum, entry) => sum + entry.short, 0), row.net, `${row.name} lines`)
          }

          same(row.moves.reduce((sum, move) => sum + move.units, 0), row.used.stockRemote + row.used.queuedRemote, `${row.name} moves`)
        }

        const asText = pm.manifestCsv(result)

        assert.equal(parseCsv(asText)[0].length, pm.CSV_COLUMNS.length)
        assert.ok(asText.split('\n').length > result.rows.length)
      }
    }

    assert.ok(pairs > 0)

    return true
  })

  add('save-manifest: with the task list unread every stocked component is held back and no shortage is smaller than with it read', async () => {
    const { sources, procurement } = await reads()
    const classes = sources.classes.filter((entry) => (sources.parts[entry.id] || []).length > 0).slice(0, 4)

    if (!classes.length) {
      return UNSUPPORTED
    }

    for (const entry of classes) {
      const plans = [{ id: 1, classId: entry.id, className: entry.name, hulls: 4 }]
      const base = { plans, parts: sources.parts, stock: sources.stock, colonies: procurement.colonies, targetId: pm.defaultTarget({ plans, parts: sources.parts, stock: sources.stock, colonies: procurement.colonies }).id, projects: procurement.projects, tasks: procurement.tasks, components: procurement.components }
      const read = pm.reconcile({ ...base, tasksRead: true })
      const unread = pm.reconcile({ ...base, tasksRead: false })

      read.rows.forEach((row, at) => {
        assert.ok(unread.rows[at].net >= row.net - 1e-9, `${row.name}: a shortage shrank when the tasks were not read`)
        assert.deepEqual(unread.rows[at].available, { local: 0, remote: 0, known: { local: 0, remote: 0 } })
        assert.ok(unread.rows[at].net === 0 || unread.rows[at].netBasis === (unread.rows[at].stock.local + unread.rows[at].stock.remote > 0 ? 'at most' : 'exact'))
      })
    }

    return true
  })

  add('save-planted: an automatic refit planted at a colony holding stock (in memory, over the read-only save) holds that colony\'s stock of the added component back and the shortage turns into an upper bound', async () => {
    const { sources, procurement } = await reads()
    const found = Object.entries(sources.stock).map(([populationId, held]) => Object.entries(held).filter(([, units]) => units > 0).map(([componentId]) => ({ populationId: Number(populationId), componentId: Number(componentId) }))).flat().find((candidate) => sources.classes.some((entry) => (sources.parts[entry.id] || []).some((mounted) => mounted.componentId === candidate.componentId)) && procurement.colonies[candidate.populationId])

    if (!found) {
      return UNSUPPORTED
    }

    const target = sources.classes.find((entry) => (sources.parts[entry.id] || []).some((mounted) => mounted.componentId === found.componentId))
    const source = sources.classes.find((entry) => !(sources.parts[entry.id] || []).some((mounted) => mounted.componentId === found.componentId))

    if (!source) {
      return UNSUPPORTED
    }

    const planted = await openSave(save.file)

    try {
      await planted.overlay(['create temp table FCT_ShipyardTask as select * from main.FCT_ShipyardTask', `insert into FCT_ShipyardTask (TaskID, GameID, RaceID, PopulationID, TaskTypeID, ClassID, RefitID, TotalBP, CompletedBP, Paused, UseComponents) values (987654, ${save.game}, ${save.race}, ${found.populationId}, 4, ${source.id}, ${target.id}, 100, 0, 0, 1)`])

      const after = await readsOf(planted)
      const plans = [{ id: 1, classId: target.id, className: target.name, hulls: 100000 }]
      const run = (reads) => pm.reconcile({ plans, parts: reads.sources.parts, stock: reads.sources.stock, colonies: reads.procurement.colonies, targetId: found.populationId, projects: reads.procurement.projects, tasks: reads.procurement.tasks, components: reads.procurement.components })
      const before = rowOf(run({ sources, procurement }), found.componentId)
      const held = rowOf(run(after), found.componentId)

      assert.equal(after.procurement.tasks.length, procurement.tasks.length + 1)
      assert.ok(before.available.local > 0, 'no stock was available before')
      assert.equal(before.reserved.unknown, 0)
      assert.equal(held.available.local, 0)
      assert.equal(held.reserved.unknown, before.stock.local)
      assert.ok(held.net > before.net - 1e-9)
      assert.equal(held.netBasis, 'at most')
    } finally {
      planted.close()
    }

    return true
  })

  add('save-planted: a stock row left without an amount (in memory, over the read-only save) is unknown, and the shortage is an upper bound; a deleted row is none held', async () => {
    const { sources, procurement } = await reads()
    const found = Object.entries(sources.stock).map(([populationId, held]) => Object.entries(held).filter(([, units]) => units > 0).map(([componentId]) => ({ populationId: Number(populationId), componentId: Number(componentId) }))).flat().find((candidate) => sources.classes.some((entry) => (sources.parts[entry.id] || []).some((mounted) => mounted.componentId === candidate.componentId)) && procurement.colonies[candidate.populationId])

    if (!found) {
      return UNSUPPORTED
    }

    const target = sources.classes.find((entry) => (sources.parts[entry.id] || []).some((mounted) => mounted.componentId === found.componentId))
    const nulled = await openSave(save.file)
    const deleted = await openSave(save.file)

    try {
      await nulled.overlay(['create temp table FCT_PopComponent as select * from main.FCT_PopComponent', `update FCT_PopComponent set Amount = null where PopulationID = ${found.populationId} and ComponentID = ${found.componentId}`])
      await deleted.overlay(['create temp table FCT_PopComponent as select * from main.FCT_PopComponent', `delete from FCT_PopComponent where PopulationID = ${found.populationId} and ComponentID = ${found.componentId}`])

      const plans = [{ id: 1, classId: target.id, className: target.name, hulls: 100000 }]
      const run = (reads) => rowOf(pm.reconcile({ plans, parts: reads.sources.parts, stock: reads.sources.stock, colonies: reads.procurement.colonies, targetId: found.populationId, projects: reads.procurement.projects, tasks: reads.procurement.tasks, components: reads.procurement.components }), found.componentId)
      const base = run({ sources, procurement })
      const unknown = run(await readsOf(nulled))
      const none = run(await readsOf(deleted))

      assert.equal((await readsOf(nulled)).sources.stock[found.populationId][found.componentId], null)
      assert.ok(!(found.componentId in ((await readsOf(deleted)).sources.stock[found.populationId] || {})))
      assert.equal(unknown.netBasis, 'at most')
      assert.equal(unknown.stock.local, null)
      assert.equal(unknown.stock.known.local, 0)
      assert.ok(unknown.net > base.net - 1e-9)
      assert.equal(none.netBasis, 'exact')
      same(none.net, unknown.net, 'a null row and a deleted row leave the same shortage; only the null one is unknown')
    } finally {
      nulled.close()
      deleted.close()
    }

    return true
  })

  add('save-planted: a component project queued at the colony (in memory) is supply in whole units, and a paused one is not', async () => {
    const { sources, procurement } = await reads()
    const mounted = Object.values(sources.parts).flat().find((entry) => procurement.components[entry.componentId] && entry.researched === 1 && entry.count > 0 && [1, 2, 3, 4].includes(entry.typeId))

    if (!mounted) {
      return UNSUPPORTED
    }

    const classId = Object.entries(sources.parts).find(([, parts]) => parts.includes(mounted))[0]
    const entry = sources.classes.find((candidate) => candidate.id === Number(classId))
    const colony = Object.keys(procurement.colonies).map(Number)[0]
    const stockFree = { ...sources.stock, [colony]: {} }
    const plans = [{ id: 1, classId: entry.id, className: entry.name, hulls: 1 }]
    const base = { plans, parts: sources.parts, colonies: procurement.colonies, targetId: colony, components: procurement.components }
    const none = pm.reconcile({ ...base, stock: Object.fromEntries(Object.keys(stockFree).map((id) => [id, {}])) })
    const queued = pm.reconcile({ ...base, stock: Object.fromEntries(Object.keys(stockFree).map((id) => [id, {}])), projects: [{ id: 1, populationId: colony, componentId: mounted.componentId, amount: 1.25, partial: 0.75, paused: 0 }] })
    const paused = pm.reconcile({ ...base, stock: Object.fromEntries(Object.keys(stockFree).map((id) => [id, {}])), projects: [{ id: 1, populationId: colony, componentId: mounted.componentId, amount: 1.25, partial: 0.75, paused: 1 }] })

    assert.equal(rowOf(queued, mounted.componentId).queued.local, 2)
    assert.ok(rowOf(queued, mounted.componentId).net < rowOf(none, mounted.componentId).net || rowOf(none, mounted.componentId).net === 0)
    assert.equal(rowOf(paused, mounted.componentId).queued.local, 0)
    assert.equal(rowOf(paused, mounted.componentId).queued.paused, 2)
    same(rowOf(paused, mounted.componentId).net, rowOf(none, mounted.componentId).net, 'a paused project changes nothing')

    return true
  })

  return { statements, database }
}

// ---------- the planted faults ----------

const MUTATIONS = [
  { name: 'a text cell that starts like a formula is written as it is', file: U, find: "{ guard: typeof value !== 'number' }", replace: '{ guard: false }', fails: ['csv'] },
  // the manifest
  { name: 'every plan counts all of the stock again', file: U, find: 'need.perPlan.forEach((entry) => {\n        let left = entry.needed', replace: 'need.perPlan.forEach((entry) => {\n        supply.forEach((lot) => { lot.left = lot.units })\n        let left = entry.needed', fails: ['once', 'save-manifest'] },
  { name: 'the need counted for one hull, not the hulls', file: U, find: 'part.count * plan.hulls', replace: 'part.count', fails: ['once'] },
  { name: 'stock elsewhere used before the stock at the colony', file: U, find: '...lots.filter((lot) => lot.here).map((lot) => ({ ...lot })),\n      ...lots.filter((lot) => !lot.here).sort(nearestFirst).map((lot) => ({ ...lot })),', replace: '...lots.filter((lot) => !lot.here).sort(nearestFirst).map((lot) => ({ ...lot })),\n      ...lots.filter((lot) => lot.here).map((lot) => ({ ...lot })),', fails: ['order'] },
  { name: 'the colonies of the same system not first', file: U, find: '...lots.filter((lot) => !lot.here).sort(nearestFirst).map((lot) => ({ ...lot })),', replace: '...lots.filter((lot) => !lot.here).map((lot) => ({ ...lot })),', fails: ['order'] },
  { name: 'queued manufacture used before stock', file: U, find: '    const supply = [\n      ...lots.filter', replace: '    const supply = [\n      ...queuedPlaces.filter((entry) => entry.here).map((entry) => ({ kind: \'queued\', ...entry })),\n      ...lots.filter', fails: ['order'] },
  { name: 'a queue elsewhere used before the queue here', file: U, find: '      ...queuedPlaces.filter((entry) => entry.here).map((entry) => ({ kind: \'queued\', ...entry })),\n      ...queuedPlaces.filter((entry) => !entry.here)', replace: '      ...queuedPlaces.filter((entry) => !entry.here).map((entry) => ({ kind: \'queued\', ...entry })),\n      ...queuedPlaces.filter((entry) => entry.here)', fails: ['order'] },
  { name: 'a queue elsewhere counted as here', file: U, find: 'populationId: Number(populationId), units, here: Number(populationId) === Number(targetId) }', replace: 'populationId: Number(populationId), units, here: true }', fails: ['order'] },
  { name: 'a stock row with no amount read as none held', file: U, find: 'return isNumber(colony[componentId]) ? Math.max(0, colony[componentId]) : null', replace: 'return isNumber(colony[componentId]) ? Math.max(0, colony[componentId]) : 0', fails: ['nulls'] },
  { name: 'an absent stock row read as unknown', file: U, find: 'if (!colony || !Object.prototype.hasOwnProperty.call(colony, componentId)) {\n    return 0\n  }', replace: 'if (!colony || !Object.prototype.hasOwnProperty.call(colony, componentId)) {\n    return null\n  }', fails: ['nulls'] },
  { name: 'a shortage on unknown supply called exact', file: U, find: 'need.needed === null ? \'not known\' : unknown.length && net > EPSILON ? \'at most\' : \'exact\'', replace: 'need.needed === null ? \'not known\' : \'exact\'', fails: ['nulls', 'held', 'queue'] },
  { name: 'an unknown claim leaves the stock free', file: U, find: 'const back = claim.unknown.length ? held : proven', replace: 'const back = proven', fails: ['held', 'save-planted'] },
  { name: 'claims beyond the stock hold back more than there is', file: U, find: 'const proven = Math.min(held, claim.proven)', replace: 'const proven = claim.proven', fails: ['held'] },
  { name: 'the available figure ignores what is held back', file: U, find: 'availableLocal += free', replace: 'availableLocal += held', fails: ['held'] },
  { name: 'an automatic refit claims nothing', file: U, find: 'ids.forEach((componentId) => claims.push(', replace: 'ids.slice(0, 0).forEach((componentId) => claims.push(', fails: ['held', 'save-planted'] },
  { name: 'an automatic refit with Use Components off claims stock', file: U, find: 'if (task.useComponents === 0) {', replace: 'if (false) {', fails: ['held'] },
  { name: 'a construction task holds the stock it used', file: U, find: 'rows.push({ ...base, state: \'taken\', reason: \'The stock this task uses was taken when it was made.\' })', replace: 'rows.push({ ...base, state: \'taken\', reason: \'The stock this task uses was taken when it was made.\' })\n      claims.push({ populationId: task.populationId, componentId: null, units: null, proof: \'unknown\', source: \'task\', taskId: task.id, reason: \'held\' })', fails: ['held', 'save-tasks'] },
  { name: 'an unread task list holds nothing', file: U, find: 'if (!read) {\n    claims.push(', replace: 'if (false) {\n    claims.push(', fails: ['held', 'save-manifest'] },
  { name: 'a task of an unknown type holds nothing', file: U, find: 'claims.push({ populationId: task.populationId === undefined ? null : task.populationId, componentId: null, units: null, proof: \'unknown\', source: \'task\', taskId: task.id, reason })', replace: 'void reason', fails: ['held'] },
  { name: 'a hand entry that is blank counted as nothing held', file: U, find: 'const proven = isNumber(entry.units) && entry.units >= 0', replace: 'const proven = !isNumber(entry.units) || entry.units >= 0', fails: ['held'] },
  { name: 'the credit of a task not worked out', file: U, find: 'Math.max(0, task.classCost - task.totalBP)', replace: 'task.totalBP', fails: ['held'] },
  { name: 'a queued unit rounded down from the remaining amount alone', file: U, find: 'Math.floor(project.amount + project.partial + 1e-6)', replace: 'Math.floor(project.amount)', fails: ['queue'] },
  { name: 'a paused project counted as supply', file: U, find: 'const side = paused ? entry.paused : entry.active', replace: 'const side = entry.active', fails: ['queue'] },
  { name: 'a project of an unknown pause state counted as running', file: U, find: 'const pauseKnown = project.paused !== null && project.paused !== undefined', replace: 'const pauseKnown = true', fails: ['queue'] },
  { name: 'a project of unknown units counted as none', file: U, find: 'if (units === null || !pauseKnown) {', replace: 'if (!pauseKnown) {', fails: ['queue'] },
  { name: 'an unread queue not named', file: U, find: 'if (!projectsRead) {\n      unknown.push(', replace: 'if (false) {\n      unknown.push(', fails: ['queue'] },
  { name: 'tons not worked out from the units', file: U, find: 'tons: tonsPerUnit === null ? null : move.units * tonsPerUnit', replace: 'tons: tonsPerUnit', fails: ['transport'] },
  { name: 'an unknown size read as 0 tons', file: U, find: 'tons: tonsPerUnit === null ? null : move.units * tonsPerUnit', replace: 'tons: (tonsPerUnit || 0) * move.units', fails: ['transport', 'csv'] },
  { name: 'stock elsewhere never moved', file: U, find: 'if (!lot.here) {\n            const existing', replace: 'if (false) {\n            const existing', fails: ['transport', 'order', 'save-manifest'] },
  { name: 'a class that mounts nothing not reported', file: U, find: '.map((plan) => `${plan.className || \'A class\'} mounts no component`)', replace: '.map(() => \'\').filter(Boolean)', fails: ['invalid'] },
  { name: 'hulls of a fraction accepted', file: U, find: 'const whole = (value) => isNumber(value) && Number.isInteger(value) && value >= 1', replace: 'const whole = (value) => isNumber(value) && value > 0', fails: ['invalid'] },
  { name: 'no colony needed accepted', file: U, find: 'if (targetId === null || targetId === undefined) {', replace: 'if (false) {', fails: ['invalid'] },
  { name: 'the default colony without a shipyard first', file: U, find: 'const yards = Number(isNumber(colony.yards) && colony.yards > 0)', replace: 'const yards = 0', fails: ['target'] },
  { name: 'the rule of the claims not for 2.7', file: U, find: 'id: \'production.procurementReservations\',\n  versions: [\'2.7.x\']', replace: 'id: \'production.procurementReservations\',\n  versions: [\'2.6.x\']', fails: ['rules'] },
  { name: 'an unknown figure exported as 0', file: U, find: 'const cell = (value) => csvCell(typeof value === \'number\' ? rounded(value) : value, {', replace: 'const cell = (value) => csvCell(typeof value === \'number\' ? rounded(value) : value ?? 0, {', fails: ['csv'] },
  { name: 'the held back and the proven claim run into one column', file: U, find: '\'Reserved (proven)\': row.reserved.proven, \'Held back (claim not known)\': row.reserved.unknown', replace: '\'Reserved (proven)\': row.reserved.proven + row.reserved.unknown, \'Held back (claim not known)\': row.reserved.unknown', fails: ['csv'] },
  { name: 'the stock here and elsewhere not told apart', file: U, find: '\'Stock here\': row.stock.local, \'Stock elsewhere\': row.stock.remote', replace: '\'Stock here\': row.stock.local + row.stock.remote, \'Stock elsewhere\': row.stock.remote', fails: ['csv'] },
  { name: 'the queue and the stock not told apart', file: U, find: '\'Queued here\': row.queued.local, \'Queued elsewhere\': row.queued.remote', replace: '\'Queued here\': row.stock.local, \'Queued elsewhere\': row.stock.remote', fails: ['csv'] },
  { name: 'the net shortage left out of the export', file: U, find: '\'Net shortage\': row.net, \'Net shortage basis\': row.netBasis', replace: '\'Net shortage basis\': row.netBasis', fails: ['csv'] },
  { name: 'the colony of a transport record lost', file: U, find: 'Colony: move.colonyName,', replace: 'Colony: move.componentName,', fails: ['csv'] },
  { name: 'the copied text without the move lines', file: U, find: 'manifest.moves.forEach((move) => lines.push(`Move', replace: ';[].forEach((move) => lines.push(`Move', fails: ['csv'] },
  { name: 'the copied text drops "at most"', file: U, find: '${row.netBasis === \'at most\' ? \'at most \' : \'\'}${figure(row.net)}', replace: '${figure(row.net)}', fails: ['csv'] },
  // the reads
  { name: 'another race\'s shipyard tasks read', file: D, find: ' and FCT_ShipyardTask.RaceID = ${RaceID}', replace: '', fails: ['loaders'] },
  { name: 'projects of every production type read', file: D, find: ' and FCT_IndustrialProjects.ProductionType = ${COMPONENT_PROJECT}', replace: '', fails: ['loaders', 'save-counts'] },
  { name: 'another race\'s projects read', file: D, find: ' and FCT_IndustrialProjects.RaceID = ${RaceID}', replace: '', fails: ['loaders'] },
  { name: 'another race\'s colonies read', file: D, find: ' where FCT_Population.GameID = ${GameID} and FCT_Population.RaceID = ${RaceID} order by', replace: ' where FCT_Population.GameID = ${GameID} order by', fails: ['loaders'] },
  { name: 'the system named from another race\'s survey', file: D, find: ' and FCT_Population.RaceID = FCT_RaceSysSurvey.RaceID\'', replace: '\'', fails: ['loaders'] },
  { name: 'the shipyards of other games counted', file: D, find: ' and FCT_Shipyard.GameID = FCT_Population.GameID', replace: '', fails: ['loaders'] },
  { name: 'the pause flag not read', file: D, find: '${projects.has(\'Pause\') ? \'FCT_IndustrialProjects.Pause\' : \'null\'} as Paused', replace: 'null as Paused', fails: ['loaders'] },
  { name: 'a column the save lacks read as 0', file: D, find: ': `null as ${name}`)', replace: ': `0 as ${name}`)', fails: ['loaders'] },
  { name: 'the class cost not read', file: D, find: '? \'FCT_ShipClass.Cost\' : \'null\'', replace: '? \'null\' : \'null\'', fails: ['loaders'] },
  { name: 'a save without shipyard tasks read as an empty list', file: D, find: 'return { tasks: [], read: false }', replace: 'return { tasks: [], read: true }', fails: ['loaders'] },
  { name: 'a save without projects read as an empty list', file: D, find: 'return { projects: [], read: false }', replace: 'return { projects: [], read: true }', fails: ['loaders'] },
  { name: 'a save without colonies read as an empty list', file: D, find: 'return { colonies: {}, read: false }', replace: 'return { colonies: {}, read: true }', fails: ['loaders'] },
  { name: 'the tons of a unit not from the size', file: D, find: 'valueOrNull(quantityOf(component, \'tons\'))', replace: 'valueOrNull(quantityOf(component, \'sizeHS\'))', fails: ['loaders', 'save-sources'] },
  { name: 'an unknown size read as 0 tons', file: D, find: 'valueOrNull(quantityOf(component, \'tons\'))', replace: '(valueOrNull(quantityOf(component, \'tons\')) || 0)', fails: ['loaders'] },
  { name: 'a null amount of a project read as 0', file: D, find: 'amount: numberOrNull(row.Amount)', replace: 'amount: numberOrNull(row.Amount) || 0', fails: ['loaders'] },
  // the component
  { name: 'hulls of 0 accepted', file: C, find: 'return Number.isInteger(value) && value >= 1 ? value : null', replace: 'return Number.isInteger(value) && value >= 0 ? value : null', fails: ['component'] },
  { name: 'a blank hand entry read as 0', file: C, find: 'return Number.isFinite(value) ? value : null', replace: 'return Number.isFinite(value) ? value : 0', fails: ['component'] },
  { name: 'the hand entries not passed on', file: C, find: 'entered: this.entered.map(', replace: 'entered: [].map(', fails: ['component'] },
  { name: 'the tasks not passed on', file: C, find: 'tasks: this.procurement.tasks,', replace: 'tasks: [],', fails: ['component'] },
  { name: 'the task list called read when it was not', file: C, find: 'tasksRead: read.tasks,', replace: 'tasksRead: true,', fails: ['component'] },
  { name: 'the queue called read when it was not', file: C, find: 'projectsRead: read.projects,', replace: 'projectsRead: true,', fails: ['component'] },
  { name: 'the projects not passed on', file: C, find: 'projects: this.procurement.projects,', replace: 'projects: [],', fails: ['component'] },
  { name: 'the plans served in reverse', file: C, find: 'return reconcile({\n        plans: this.planList,', replace: 'return reconcile({\n        plans: [...this.planList].reverse(),', fails: ['component'] },
  { name: 'the colony chosen ignored', file: C, find: 'if (this.chosenTarget !== null && this.procurement.colonies[this.chosenTarget]) {', replace: 'if (false) {', fails: ['component'] },
  { name: 'an invalid manifest exported', file: C, find: 'return !this.manifest.invalid', replace: 'return true', fails: ['component'] },
  { name: 'the sizes of the tons not passed on', file: C, find: 'components: this.procurement.components,', replace: 'components: {},', fails: ['component'] },
  { name: 'the panel without a data-summary', file: C, find: 'class="panel procurement-manifest" data-summary="', replace: 'class="panel procurement-manifest" data-sum="', fails: ['template'] },
  { name: 'the data-summary with a figure', file: C, find: 'data-summary="Find component shortages for a batch of hulls', replace: 'data-summary="Find component shortages for a batch of 100 hulls', fails: ['template'] },
  { name: 'the foot speaking to a person', file: C, find: 'The classes are served in the order listed', replace: 'Your classes are served in the order listed', fails: ['template'] },
  { name: 'the CSV button gone', file: C, find: ' data-manifest-csv @click="downloadCsv"', replace: '', fails: ['template'] },
  { name: 'the copy button gone', file: C, find: ' data-manifest-copy @click="copyText"', replace: '', fails: ['template'] },
  { name: 'the claims without a mark', file: C, find: '<provenance-mark rule="production.procurementReservations" />', replace: '', fails: ['template'] },
  { name: 'an upper bound not shown as one', file: C, find: '{{ item.netBasis === \'at most\' ? \'at most \' : \'\' }}', replace: '', fails: ['template'] },
  { name: 'the transport table gone', file: C, find: ' data-manifest-moves>', replace: '>', fails: ['template'] },
  // the page
  { name: 'the read labelled under another name', file: P, find: 'procurementSources: \'the shipyard tasks', replace: 'procurementSource: \'the shipyard tasks', fails: ['page'] },
  { name: 'the read tracked under another name', file: P, find: 'tracked(\'procurementSources\'', replace: 'tracked(\'procurementSource\'', fails: ['page'] },
  { name: 'the manifest given the calculator\'s read as its own', file: P, find: ':procurement="procurementSources" />', replace: ':procurement="componentSources" />', fails: ['page'] },
  { name: 'the manifest read for no race', file: P, find: 'loadProcurementSources(this.database, { GameID: this.GameID, RaceID: this.RaceID })', replace: 'loadProcurementSources(this.database, { GameID: this.GameID, RaceID: 0 })', fails: ['page', 'save-counts'] },

  // the unknown stock, the text and the manufacturing locations
  { name: 'a stock with no amount counted as the rows that were read', file: U, find: 'stock: { local: stockLocalUnknown ? null : stockLocal, remote: stockRemoteUnknown ? null : stockRemote, known:', replace: 'stock: { local: stockLocal, remote: stockRemote, known:', fails: ['unknown', 'nulls'] },
  { name: 'an available with no stock amount counted as the rows that were read', file: U, find: 'available: { local: stockLocalUnknown ? null : availableLocal, remote: stockRemoteUnknown ? null : availableRemote, known:', replace: 'available: { local: availableLocal, remote: availableRemote, known:', fails: ['unknown'] },
  { name: 'a spare stock given where a stock is not known', file: U, find: 'need.needed === null || stockLocalUnknown || stockRemoteUnknown ? null', replace: 'need.needed === null ? null', fails: ['unknown'] },
  { name: 'the unknown stock told as the known rows in the text', file: U, find: 'stock here ${stockText(row.stock.local, row.stock.known.local)}, elsewhere ${stockText(row.stock.remote, row.stock.known.remote)}', replace: 'stock here ${figure(row.stock.known.local)}, elsewhere ${figure(row.stock.known.remote)}', fails: ['unknown'] },
  { name: 'the available left out of the text', file: U, find: '; available here ${stockText(row.available.local, row.available.known.local)}, elsewhere ${stockText(row.available.remote, row.available.known.remote)}', replace: '', fails: ['text'] },
  { name: 'the queue here and elsewhere run together in the text', file: U, find: 'queued here ${stockText(row.queued.local, row.queued.known.local)}, elsewhere ${stockText(row.queued.remote, row.queued.known.remote)}, paused', replace: 'queued here ${figure(row.queued.known.local + row.queued.known.remote)}, elsewhere 0, paused', fails: ['text'] },
  { name: 'the paused units left out of the text', file: U, find: ', paused ${stockText(row.queued.paused, row.queued.known.paused)}; net shortage', replace: '; net shortage', fails: ['text'] },
  { name: 'the manufacturing locations left out of the export', file: U, find: 'manifest.manufacture.forEach((entry) => lines.push(record(', replace: 'manifest.manufacture.filter(() => false).forEach((entry) => lines.push(record(', fails: ['manufacture', 'csv'] },
  { name: 'the manufacturing locations left out of the text', file: U, find: 'manifest.manufacture.forEach((entry) => lines.push(`Manufacture', replace: 'manifest.manufacture.filter(() => false).forEach((entry) => lines.push(`Manufacture', fails: ['manufacture'] },
  { name: 'a paused project counted as supply', file: U, find: 'const queuedPlaces = Object.entries(project.active)', replace: 'const queuedPlaces = Object.entries({ ...project.paused, ...project.active })', fails: ['manufacture'] },
  { name: 'the units of a location all told as used', file: U, find: 'const usedHere = lot && need.needed !== null ? lot.units - lot.left : null', replace: 'const usedHere = lot && need.needed !== null ? lot.units : null', fails: ['manufacture'] },
  { name: 'the units not used of a location told as none', file: U, find: 'unused: usedHere === null || entry.incomplete ? null : lot.units - usedHere', replace: 'unused: usedHere === null || entry.incomplete ? null : 0', fails: ['manufacture'] },
  { name: 'the colony of a manufacturing record lost', file: U, find: 'Colony: entry.colonyName, System: entry.systemName', replace: 'Colony: entry.componentName, System: entry.systemName', fails: ['manufacture'] },
  { name: 'the panel keys a manufacturing location without its state', file: C, find: '`${entry.componentId}-${entry.populationId}-${entry.state}`', replace: '`${entry.componentId}-${entry.populationId}`', fails: ['manufacture'] },
  { name: 'the panel shows the unknown stock here as its known rows', file: C, find: '({{ figure(item.stock.known.local) }} known)', replace: '({{ figure(item.stock.local) }} known)', fails: ['template'] },
  { name: 'the size of a component not declared among the reads of the page', file: K, find: 'procurementSources: \'FCT_ShipDesignComponents(Size Cost)\'', replace: 'procurementSources: \'FCT_ShipDesignComponents(Cost)\'', fails: ['registry'] },

  // the projects whose units or pause flag are not known
  { name: 'a project of units not known dropped with its colony', file: U, find: 'project.uncertain.forEach((entry) => keep(entry.populationId, entry.state, entry.units))', replace: 'void project.uncertain', fails: ['queueunknown'] },
  { name: 'the queued totals counted as the known projects only', file: U, find: 'queued: { local: queuedLocalUnknown ? null : queuedLocal, remote: queuedRemoteUnknown ? null : queuedRemote, paused: pausedUnknown ? null : pausedUnits,', replace: 'queued: { local: queuedLocal, remote: queuedRemote, paused: pausedUnits,', fails: ['queueunknown'] },
  { name: 'a project of units not known counted as supply', file: U, find: 'const units = projectUnits(project)\n', replace: 'const units = projectUnits(project) === null ? 5 : projectUnits(project)\n', fails: ['queueunknown'] },
  { name: 'a location with more units than known told as complete', file: U, find: 'incomplete: entry.incomplete, used:', replace: 'incomplete: false, used:', fails: ['queueunknown'] },
  { name: 'units not known exported as 0', file: U, find: "'Manufactured units': entry.incomplete ? null : entry.units,", replace: "'Manufactured units': entry.units || 0,", fails: ['queueunknown'] },
  { name: 'the unknown remote queue told as the known projects in the text', file: U, find: 'elsewhere ${stockText(row.queued.remote, row.queued.known.remote)}', replace: 'elsewhere ${figure(row.queued.known.remote)}', fails: ['queueunknown'] },
  { name: 'the panel hides the known part beside an unknown queue', file: C, find: '<span v-if="item.queued.remote === null" class="caption text--secondary">', replace: '<span v-if="false" class="caption text--secondary">', fails: ['template'] },
  // the alien components, the unknown demand and the mixed claims
  { name: 'an alien component built with the hull', file: U, find: 'const route = part.researched === 0 ? \'stock\' :', replace: 'const route = false ? \'stock\' :', fails: ['alien'] },
  { name: 'the stock-required route left out of the export', file: U, find: 'stock: \'stock required (not researched by the race)\' }', replace: '}', fails: ['alien'] },
  { name: 'a stock-required shortage said to be built with the hull in the text', file: U, find: 'row.route === \'stock\' ? \' (stock required: the race has not researched it, so it cannot be made)\' : \'\'', replace: 'row.route === \'stock\' ? \' (built with the hull)\' : \'\'', fails: ['alien'] },
  { name: 'a stock-required shortage given a cost in build points', file: U, find: 'need.cost !== null && need.route !== \'stock\' ? net * need.cost : null', replace: 'need.cost !== null ? net * need.cost : null', fails: ['alien'] },
  { name: 'the stock-required total folded into the hull total', file: U, find: 'netHull: byRoute(\'hull\'),', replace: 'netHull: sumOf(known.filter((row) => row.route === \'hull\' || row.route === \'stock\'), (row) => row.net),', fails: ['alien'] },
  { name: 'the panel does not name a stock-required route', file: C, find: 'row.route === \'stock\' ? \'stock required, not researched by the race\' :', replace: '', fails: ['alien'] },
  { name: 'the panel leaves the not-available shortage out of its note', file: C, find: '[totals.netStock, \'not available (stock required)\'], ', replace: '', fails: ['alien'] },
  { name: 'the net shortage total adding up the known rows only', file: U, find: 'net: unknownNeed ? null : sumOf(known, (row) => row.net),', replace: 'net: sumOf(known, (row) => row.net),', fails: ['unknowndemand', 'nulls'] },
  { name: 'the units to move total adding up the known rows only', file: U, find: 'units: unknownNeed ? null : sumOf(moves, (move) => move.units),', replace: 'units: sumOf(moves, (move) => move.units),', fails: ['unknowndemand'] },
  { name: 'the tons to move total adding up the known rows only', file: U, find: 'tons: unknownNeed || !moves.every(', replace: 'tons: !moves.every(', fails: ['unknowndemand'] },
  { name: 'the needed total adding up the known rows only', file: U, find: 'needed: unknownNeed ? null : sumOf(rows, (row) => row.needed),', replace: 'needed: sumOf(rows.filter((row) => row.needed !== null), (row) => row.needed),', fails: ['unknowndemand'] },
  { name: 'the usage of a component with no known need told as 0', file: U, find: 'const used = need.needed === null ? { stockLocal: null, stockRemote: null, queuedLocal: null, queuedRemote: null } : { stockLocal: 0, stockRemote: 0, queuedLocal: 0, queuedRemote: 0 }', replace: 'const used = { stockLocal: 0, stockRemote: 0, queuedLocal: 0, queuedRemote: 0 }', fails: ['unknowndemand'] },
  { name: 'the units to move of a component with no known need exported as 0', file: U, find: '\'Units to move\': row.needed === null ? null : ', replace: '\'Units to move\': ', fails: ['unknowndemand'] },
  { name: 'the panel tile of the units to move reading 0 for a need not known', file: C, find: 'totals.units === null ? \'Not known\' : `', replace: '`', fails: ['unknowndemand'] },
  { name: 'the panel tile of the net shortage reading the known subtotal', file: C, find: 'value: this.figure(totals.net), note: totals.net === null ?', replace: 'value: this.figure(totals.netKnown), note: totals.net === null ?', fails: ['unknowndemand'] },
  { name: 'the panel usage cell reading 0 for a need not known', file: C, find: '{{ item.needed === null ? \'not known\' : `', replace: '{{ `', fails: ['template'] },
  { name: 'an unknown claim erasing the proven reservation', file: U, find: 'provenHeld += proven\n', replace: 'provenHeld += claim.unknown.length ? 0 : proven\n', fails: ['claims'] },
  { name: 'an unknown claim holding back the proven stock twice', file: U, find: 'unknownHeld += held - proven', replace: 'unknownHeld += held', fails: ['claims'] },
  { name: 'a stock requirement only where the other flags are known', file: U, find: 'const route = part.researched === 0 ? \'stock\' :', replace: 'const route = part.researched === 0 && buildability.buildable === false && part.prototype === 0 && part.shippingLine === 0 ? \'stock\' :', fails: ['alien'] },
  { name: 'a component whose research is not known routed by its other flags', file: U, find: ': !isNumber(part.researched) ? \'unknown\' : buildability.buildable === true', replace: ': buildability.buildable === true', fails: ['alien'] },
]

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own ----------

const TEXTS = {}
const textOf = (file) => (TEXTS[file] = TEXTS[file] || fs.readFileSync(path.join(root, file), 'utf8'))

const sourcesOf = (mutant) => {
  const sources = Object.fromEntries([U, D, C, P, K].map((file) => [file, textOf(file)]))

  if (mutant) {
    sources[mutant.file] = patched(mutant.file, sources[mutant.file], mutant.find, mutant.replace)
  }

  return sources
}

const contextOf = async (sources) => {
  const utilitySources = Object.fromEntries([U, D, K].filter((file) => sources[file] !== textOf(file)).map((file) => [FILES[file], sources[file]]))
  const m = await loadUtilities(NAMES, { stubs: STUBS, sources: utilitySources })
  const moduleSources = Object.fromEntries(Object.entries(utilitySources).map(([name, text]) => [`utilities/${name}`, text]))
  const componentOptions = await loadPage(COMPONENT_NAME, { stubs: STUBS, sources: { [COMPONENT_NAME]: sources[C], ...moduleSources } })
  const pageOptions = await loadPage('pages/production', { stubs: STUBS, sources: { 'pages/production': sources[P], ...moduleSources } })

  return { m, componentOptions, pageOptions, componentText: sources[C], pageText: sources[P] }
}

const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      result = await test()
    } catch (error) {
      result = `threw ${String(error.message).split('\n').slice(0, 3).join(' | ').slice(0, 500)}`
    }

    results.push([name, result])
  }

  return results
}

// The statements of one run: those that need no save, and the saves' own when `withSaves`.
const statementsOf = async (ctx, withSaves, keys = null) => {
  const statements = [...pure(ctx), ...loaders(ctx), ...components(ctx), ...templates(ctx)]
  const opened = []
  const skipped = []

  if (withSaves && !NO_SAVES) {
    for (const save of SAVES) {
      const result = await saveStatements(ctx, save)

      if (result.skipped) {
        skipped.push(save.file)
      } else {
        statements.push(...result.statements)
        opened.push(result.database)
      }
    }
  }

  return { statements: statements.filter(([name]) => !keys || keys.includes(keyOf(name))), opened, skipped }
}

const checkHead = async () => {
  const ctx = await contextOf(sourcesOf(null))
  const { statements, opened, skipped } = await statementsOf(ctx, true)

  console.log('\nThe net component procurement manifest, on plans, stock and queues worked by hand, on a database of its own, on the component and the page and on the saves')

  for (const file of skipped) {
    console.log(`SKIP  ${file} is not there`)
  }

  const fixtureKeys = new Set(statements.filter(([name]) => !isSaveKey(keyOf(name))).map(([name]) => keyOf(name)))
  const unwitnessed = MUTANTS.filter((mutant) => !mutant.fails.some((key) => fixtureKeys.has(key))).map((mutant) => mutant.name)

  check('mutants: every planted fault names a check on the fixtures, so that it is caught with no save there (`--no-saves`)', unwitnessed.length === 0, unwitnessed.join('; '))

  for (const [name, result] of await runStatements(statements)) {
    if (result === UNSUPPORTED) {
      console.log(`UNSUPPORTED  ${name}  [the save holds no case]`)
    } else {
      check(name, result)
    }
  }

  opened.forEach((database) => database.close())
}

const isSaveKey = (key) => key.startsWith('save-')

const checkMutant = async (mutant) => {
  const began = Date.now()
  let sources

  try {
    sources = sourcesOf(mutant)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `invalid mutant: ${error.message}`)

    return
  }

  let ctx

  try {
    ctx = await contextOf(sources)
  } catch (error) {
    check(`mutation caught: ${mutant.name}`, `does not load: ${error.message}`)

    return
  }

  const { statements, opened } = await statementsOf(ctx, mutant.fails.some(isSaveKey), mutant.fails)
  // A key of a check on a fixture must exist and fail; a key of a check on a save (`save-…`) is a further witness, required to fail only where the save is there and holds a case, so the run does not depend on the saves being present.
  const absent = mutant.fails.filter((key) => !isSaveKey(key) && !statements.some(([name]) => keyOf(name) === key))
  const results = await runStatements(statements, mutant.fails)
  const keyed = (key) => results.filter(([name]) => keyOf(name) === key)
  const missed = mutant.fails.filter((key) => !(isSaveKey(key) && keyed(key).every(([, result]) => result === UNSUPPORTED)) && !keyed(key).some(([, result]) => result !== true && result !== UNSUPPORTED))

  opened.forEach((database) => database.close())
  check(`mutation caught: ${mutant.name}`, absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true && result !== UNSUPPORTED).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else if (argv[index] === '--no-saves') {
      // Skips the saves, as on a machine without them: the planted faults must still be caught by the checks on the fixtures.
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  if (options.part !== null) {
    const mutant = MUTANTS.find(({ id }) => id === options.part)

    if (options.part === 'head') {
      await checkHead()
    } else if (mutant) {
      await checkMutant(mutant)
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  const wanted = options.mutations ? MUTANTS : []
  const extra = NO_SAVES ? ['--no-saves'] : []
  const sections = await runSections(__filename, [{ args: ['--part', 'head', ...extra], weight: 30 }, ...wanted.map(({ id, fails }) => ({ args: ['--part', id, ...extra], weight: fails.some(isSaveKey) && !NO_SAVES ? 12 : 3 }))])
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
  }

  printed()

  if (wanted.length) {
    console.log('\nPlanted faults: each must fail the checks it names')
    wanted.forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
