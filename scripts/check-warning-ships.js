// The damaged-ships warning's repair cost through its real SQL against an in-memory save: every damaged instance of a component counts, twice its stored cost each, and a count or a cost that is not stored is a dash and an unavailable result.
// Run: bun scripts/check-warning-ships.js [--no-mutations] [--only=<case>]
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')

const file = path.resolve(__dirname, '../src/renderer/utilities/warnings/ships.js')
const original = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (items, test) => items.reduce((groups, item) => { groups[test(item) ? 0 : 1].push(item); return groups }, [[], []])',
}

// The columns the damaged-ships query reads: a ship of the selected race, its fleet's name, each damaged component of it with the stored count, and the component's name and cost.
const opened = () => {
  const raw = new Database(':memory:')

  raw.exec(`
    create table FCT_Ship (ShipID, FleetID, ShipName, ShippingLineID, GameID, RaceID);
    create table FCT_Fleet (FleetID, FleetName);
    create table FCT_DamagedComponent (ShipID, ComponentID, Number, GameID);
    create table FCT_ShipDesignComponents (SDComponentID, Name, Cost);
    insert into FCT_Ship values (1, 1, 'Ship', 0, 1, 1);
    insert into FCT_Fleet values (1, 'Fleet');
    insert into FCT_ShipDesignComponents values (10, 'Gun', 10);
    insert into FCT_ShipDesignComponents values (11, 'Engine', 4);
  `)

  return raw
}

const read = async (modules, plant = () => {}) => {
  const raw = opened()

  try {
    plant(raw)

    const ctx = { GameID: 1, RaceID: 1, separator: ',', count: modules['warnings/common'].counter(','), database: { query: async (sql) => [raw.query(sql).all()] } }

    return await modules['warnings/index'].checkByKey['damaged-ships'].read(ctx)
  } finally {
    raw.close()
  }
}

const damaged = (rows) => (raw) => raw.exec(`insert into FCT_DamagedComponent values ${rows.map(([ComponentID, Number]) => `(1, ${ComponentID}, ${Number === null ? 'null' : Number}, 1)`).join(', ')}`)

const CASES = [
  {
    name: 'repair-cost',
    run: async (modules) => {
      // Three guns at a cost of 10 and one engine at a cost of 4: 3 x 2 x 10 + 1 x 2 x 4 = 68 MSP, not 2 x 10 + 2 x 4 = 28.
      const [ship] = await read(modules, damaged([[10, 3], [11, 1]]))

      assert.equal(ship.cells.components, 'Gun (60 MSP), Engine (8 MSP)', 'each component line counts every damaged instance at twice its cost')
      assert.equal(ship.cells.cost, '68 MSP', 'the ship total counts every damaged instance')
      assert.equal(ship.signature, '10,11', 'the signature is still the sorted component ids')
    },
  },
  {
    name: 'unknown-count',
    run: async (modules) => {
      const [ship] = await read(modules, damaged([[10, null]]))

      assert.equal(ship.cells.components, 'Gun (— MSP)', 'a count that is not stored leaves the component cost unknown, never one instance')
      assert.equal(ship.cells.cost.text, '—', 'a count that is not stored leaves the ship total unknown')
      assert.equal(ship.cells.cost.result.status, 'unavailable')
      assert.deepEqual(ship.cells.cost.result.inputs.missing, ['the number of damaged instances of a component'], 'the unknown result names the count')
    },
  },
  {
    name: 'unknown-cost',
    run: async (modules) => {
      const [ship] = await read(modules, (raw) => {
        damaged([[10, 3]])(raw)
        raw.exec('update FCT_ShipDesignComponents set Cost = null where SDComponentID = 10')
      })

      assert.equal(ship.cells.components, 'Gun (— MSP)', 'a cost that is not stored leaves the component cost unknown, never 0')
      assert.equal(ship.cells.cost.text, '—')
      assert.deepEqual(ship.cells.cost.result.inputs.missing, ['the cost of a damaged component'], 'the unknown result names the cost')
    },
  },
  {
    name: 'unknown-cost-and-count',
    run: async (modules) => {
      const [ship] = await read(modules, (raw) => {
        damaged([[10, null]])(raw)
        raw.exec('update FCT_ShipDesignComponents set Cost = null where SDComponentID = 10')
      })

      assert.equal(ship.cells.components, 'Gun (— MSP)', 'a cost and a count that are not stored leave the component cost unknown')
      assert.equal(ship.cells.cost.text, '—')
      assert.deepEqual(ship.cells.cost.result.inputs.missing, ['the cost of a damaged component', 'the number of damaged instances of a component'], 'the unknown result names both inputs that are missing')
    },
  },
  {
    name: 'zero-cost',
    run: async (modules) => {
      const [ship] = await read(modules, (raw) => {
        damaged([[10, 3]])(raw)
        raw.exec('update FCT_ShipDesignComponents set Cost = 0 where SDComponentID = 10')
      })

      assert.equal(ship.cells.components, 'Gun (0 MSP)', 'a stored cost of zero stays zero')
      assert.equal(ship.cells.cost, '0 MSP')
    },
  },
  {
    name: 'labels',
    run: (modules) => {
      const rule = modules.provenance.getRule('warnings.damagedShips')

      assert.deepEqual(rule.versions, ['3.2.x'], 'the repaired rule supports the expected formula line')
      assert.equal(rule.verification, 'confirmed')
      assert.ok(rule.note.includes('every damaged instance'), 'the note states the count the cost takes')
    },
  },
]

const FAULTS = [
  { name: 'a component\'s repair cost leaves out the damaged count', from: 'known ? item.ComponentCost * 2 * item.ComponentNumber : null', to: 'known ? item.ComponentCost * 2 : null', fails: 'repair-cost' },
  { name: 'the ship\'s repair total leaves out the damaged count', from: 'ship.TotalCost += item.ComponentCost * item.ComponentNumber', to: 'ship.TotalCost += item.ComponentCost', fails: 'repair-cost' },
  { name: 'a missing count is named as a missing cost', from: 'ship.CostGaps.push(COUNT)', to: 'ship.CostGaps.push(COST)', fails: 'unknown-count' },
  { name: 'a missing cost and count name only the cost', from: '          if (!isKnownNumber(item.ComponentCost)) {\n            ship.CostGaps.push(COST)\n          }\n\n          if (!isKnownNumber(item.ComponentNumber)) {\n            ship.CostGaps.push(COUNT)\n          }', to: '          ship.CostGaps.push(isKnownNumber(item.ComponentCost) ? COUNT : COST)', fails: 'unknown-cost-and-count' },
]

const main = async () => {
  const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7)
  const cases = CASES.filter((one) => !only || one.name === only)

  assert.ok(cases.length > 0, 'the selected case exists')

  const load = (source) => loadUtilities(['warnings/index', 'warnings/common', 'provenance'], { stubs: STUBS, sources: { 'warnings/ships': source } })
  const modules = await load(original)

  for (const one of cases) {
    await one.run(modules)
    console.log(`PASS ${one.name}`)
  }

  if (mutating() && !only) {
    for (const fault of FAULTS) {
      const mutant = await load(plantedPatch(file, original, fault.from, fault.to))
      let caught = false

      try {
        await CASES.find((one) => one.name === fault.fails).run(mutant)
      } catch (error) {
        if (error.code !== 'ERR_ASSERTION') {
          throw error
        }

        caught = true
      }

      assert.ok(caught, `the planted fault is caught by a wrong figure: ${fault.name}`)
      console.log(`PASS mutant: ${fault.name}`)
    }
  }

  console.log(`${cases.length} of ${cases.length} damaged-ship warning checks passed`)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
