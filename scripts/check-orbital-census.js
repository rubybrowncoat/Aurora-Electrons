// Public seam: planted SQLite rows -> loadOrbitalCensus. The completed-world oracle uses rational BigInts, never production decimal/selector/assignment helpers. It tests the saved snapshot, not a later increment.
const fs = require('fs')
const path = require('path')
const { Database } = require('bun:sqlite')
const assert = require('./lib/bounded-assert')
const { plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { runChild } = require('./lib/check-pool')
const { loadUtilities } = require('./lib/utilities')
const { strictRecords } = require('./lib/csv-records')
const { PLAYED, PLAYED_NEXT, PLAYED_C1, PLAYED_C2 } = require('./lib/fixtures')

// Plant the exported headers themselves, not a second hand-maintained schema. Reject misspelled fixture cells rather than silently dropping them.
const TABLES = ['FCT_Population', 'FCT_SystemBody', 'FCT_Fleet', 'FCT_Ship', 'FCT_ShipClass', 'FCT_ClassComponent', 'FCT_ShipDesignComponents', 'FCT_DamagedComponent', 'FCT_ShipCargo', 'FCT_MoveOrders', 'FCT_Species']
const SCHEMA = Object.fromEntries(TABLES.map((table) => [table, strictRecords(fs.readFileSync(path.resolve(__dirname, '..', '.github', 'exports', `${table}.csv`), 'utf8').split(/\r?\n/, 1)[0])[0]]))
const world = () => ({
  FCT_Population: [{ GameID: 1, PopulationID: 1, RaceID: 7, Population: 0, SystemBodyID: 1, SystemID: 1 }],
  FCT_SystemBody: [{ GameID: 1, SystemBodyID: 1, Xcor: 0, Ycor: 0 }],
  FCT_Fleet: [{ GameID: 1, FleetID: 1, RaceID: 7, AssignedPopulationID: 1, CivilianFunction: 0, Xcor: 0, Ycor: 0, SystemID: 1 }],
  FCT_Ship: [{ GameID: 1, ShipID: 1, FleetID: 1, ShipClassID: 1, RaceID: 7 }],
  FCT_ShipClass: [{ GameID: 1, ShipClassID: 1, ArkShip: 1 }],
  FCT_ClassComponent: [{ GameID: 1, ClassID: 1, ComponentID: 1, NumComponent: 1 }],
  FCT_ShipDesignComponents: [{ GameID: 0, SDComponentID: 1, ComponentTypeID: 17, SpecialFunction: 7, ComponentValue: 1 }],
  FCT_DamagedComponent: [],
  FCT_ShipCargo: [{ GameID: 1, ShipID: 1, SpeciesID: 1, CargoTypeID: 1, Amount: 1 }],
  FCT_MoveOrders: [],
  FCT_Species: [{ GameID: 1, SpeciesID: 1 }],
})
const planted = async (census, rows, drop = []) => {
  const raw = new Database(':memory:')
  try {
    for (const [table, columns] of Object.entries(SCHEMA)) {
      if (drop.includes(table)) continue
      raw.exec(`create table ${table} (${columns.map((column) => `"${column}"`).join(', ')})`)
      for (const row of rows[table]) {
        for (const column of Object.keys(row)) assert.ok(columns.includes(column), `${table}.${column}: fixture column exists in the export`)
        raw.query(`insert into ${table} values (${columns.map(() => '?').join(', ')})`).run(...columns.map((column) => row[column] === undefined ? null : row[column]))
      }
    }
    return await census.loadOrbitalCensus({ query: async (sql) => [raw.query(sql).all()] }, { GameID: 1, RaceID: 7 })
  } finally { raw.close() }
}

// Exact rational arithmetic is independent of the renderer decimal implementation. These fixtures use literal decimal loads with <=15 significant digits, whose products and sums fit without decimal rounding; special load-conversion controls below name their expected literals separately.
const rational = (text) => {
  const [digits, exponent = '0'] = String(text).split(/e/i)
  const [whole, fraction = ''] = digits.split('.')
  const scale = fraction.length - Number(exponent)
  return scale < 0 ? { n: BigInt(whole + fraction) * 10n ** BigInt(-scale), d: 1n } : { n: BigInt(whole + fraction), d: 10n ** BigInt(scale) }
}
const R0 = { n: 0n, d: 1n }
const add = (a, b) => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d })
const multiply = (a, b) => ({ n: a.n * b.n, d: a.d * b.d })
const compare = (a, b) => a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0
const smaller = (a, b) => compare(a, b) <= 0 ? a : b
const integer = (n) => ({ n, d: 1n })
const decimalRational = (value) => ({ n: value.m, d: 10n ** BigInt(value.s) })
const INT = 2147483647n
const clone = (value) => structuredClone(value)
// The oracle derives direct-double ties-even from the IEEE numerator and denominator, not Math.round or the production conversion.
const cargoInteger = (value) => {
  assert.ok(Number.isFinite(value) && value >= 0, 'oracle supported quantity')
  const bytes = new DataView(new ArrayBuffer(8))
  bytes.setFloat64(0, value)
  const bits = bytes.getBigUint64(0)
  const exponent = Number((bits >> 52n) & 2047n)
  const significand = (bits & ((1n << 52n) - 1n)) + (exponent ? 1n << 52n : 0n)
  const shift = (exponent || 1) - 1023 - 52
  const numerator = shift >= 0 ? significand << BigInt(shift) : significand
  const denominator = shift >= 0 ? 1n : 1n << BigInt(-shift)
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  const result = quotient + (remainder * 2n > denominator || (remainder * 2n === denominator && quotient % 2n === 1n) ? 1n : 0n)
  assert.ok(result <= INT, 'oracle supported integer conversion')
  return result
}

// Completed-world transcription. Rows are joined only after every declared unknown cell is filled. Each row can choose one ship/component; damage uses planted insertion order. New assignees are saved-state alternatives on the target body, not an interleaved global population pass.
const completedCounts = (rows, target) => {
  const body = rows.FCT_SystemBody.find((row) => row.SystemBodyID === target.SystemBodyID)
  let totals = [0n]
  for (const fleet of rows.FCT_Fleet) {
    if (fleet.RaceID !== 7 || fleet.CivilianFunction !== 0 || rows.FCT_MoveOrders.some((order) => order.FleetID === fleet.FleetID)) continue
    if (!(Math.abs(fleet.Xcor - body.Xcor) < 1 && Math.abs(fleet.Ycor - body.Ycor) < 1)) continue
    const held = rows.FCT_Population.find((row) => row.PopulationID === fleet.AssignedPopulationID)
    let membership
    if (held && held.PopulationID === target.PopulationID) membership = [true]
    else if (held && held.SystemBodyID === target.SystemBodyID) membership = [false]
    else {
      const assignees = rows.FCT_Population.filter((row) => row.RaceID === 7 && row.SystemBodyID === target.SystemBodyID)
      membership = assignees.length === 1 ? [true] : [false, true]
    }
    let occupants = R0
    for (const ship of rows.FCT_Ship.filter((row) => row.FleetID === fleet.FleetID)) {
      const shipClass = rows.FCT_ShipClass.find((row) => row.ShipClassID === ship.ShipClassID)
      if (shipClass.ArkShip !== 1) continue
      let cargo = 0n
      for (const row of rows.FCT_ShipCargo) if (row.ShipID === ship.ShipID && row.CargoTypeID === 1 && rows.FCT_Species.some((species) => species.SpeciesID === row.SpeciesID)) cargo += cargoInteger(row.Amount)
      assert.ok(cargo <= INT, 'oracle checked cargo sum')
      let capacity = R0
      for (const part of rows.FCT_ClassComponent.filter((row) => row.ClassID === ship.ShipClassID)) {
        const definition = rows.FCT_ShipDesignComponents.find((row) => row.SDComponentID === part.ComponentID)
        if (definition.ComponentTypeID !== 17 || definition.SpecialFunction !== 7) continue
        const count = rational(part.NumComponent)
        const truncated = count.n / count.d
        const first = rows.FCT_DamagedComponent.find((row) => row.ShipID === ship.ShipID && row.ComponentID === part.ComponentID)
        const damage = first ? cargoInteger(first.Number) : 0n
        assert.ok(truncated <= INT && damage <= truncated, 'oracle supported count/damage')
        capacity = add(capacity, multiply(integer(truncated - damage), rational(definition.ComponentValue)))
      }
      occupants = add(occupants, smaller(integer(cargo), capacity))
    }
    const people = occupants.n / occupants.d
    assert.ok(people <= INT, 'oracle checked fleet conversion')
    totals = totals.flatMap((previous) => membership.map((included) => previous + (included ? people : 0n)))
  }
  return totals
}

const cases = []
const example = (name, change = () => {}, cells = [], partition = 'Fully known world; one completion.') => {
  const rows = world()
  change(rows)
  for (const [table, index, field] of cells) rows[table][index][field] = null
  cases.push({ name, rows, cells, partition })
}
const extraCargo = (rows, patch = {}) => rows.FCT_ShipCargo.push({ ...rows.FCT_ShipCargo[0], ...patch })
const extraComponent = (rows, patch = {}, definition = {}) => {
  rows.FCT_ClassComponent.push({ ...rows.FCT_ClassComponent[0], ComponentID: 2, ...patch })
  rows.FCT_ShipDesignComponents.push({ ...rows.FCT_ShipDesignComponents[0], SDComponentID: 2, ...definition })
}
const extraShip = (rows, fleetID = 1) => {
  const id = rows.FCT_Ship.length + 1
  rows.FCT_Ship.push({ ...rows.FCT_Ship[0], ShipID: id, FleetID: fleetID })
  extraCargo(rows, { ShipID: id })
}
const extraColony = (rows, patch = {}) => rows.FCT_Population.push({ ...rows.FCT_Population[0], PopulationID: 2, ...patch })
const boundedCargo = [['FCT_ShipCargo', 1, 'Amount', [0, 0.5, 0.5000000000000001, 1, 2, 2147483646]]]
const cargoPartition = 'An extra amount converts to any integer in [0, Int32.MaxValue-1], respecting the readable one-person cargo and checked sum. A readable berth cap of at most one saturates at one; zero, ties, their neighbour and the supported maximum cover every output region.'
example('Sol R1 NULL category positive', () => {}, [['FCT_ShipCargo', 0, 'CargoTypeID', [0, 1]]], 'Colonist and non-colonist are the exhaustive classification equivalence classes.')
example('Sol R1 NULL category zero', (w) => { w.FCT_ShipCargo[0].Amount = 0 }, [['FCT_ShipCargo', 0, 'CargoTypeID', [0, 1]]])
example('Sol R1 other cargo excludes unread amount', (w) => { w.FCT_ShipCargo[0].CargoTypeID = 2 }, [['FCT_ShipCargo', 0, 'Amount', [0, 1, 2147483647]]], 'Known other category excludes every supported amount.')
example('Sol R2 readable positive plus unread extra one-person cap', (w) => extraCargo(w), boundedCargo, cargoPartition)
example('Sol R2 sub-person cap yields fleet zero', (w) => { extraCargo(w); w.FCT_ShipDesignComponents[0].ComponentValue = 0.1 }, boundedCargo, cargoPartition)
example('Sol R2 readable lower bound survives extra cargo', (w) => { extraCargo(w); w.FCT_ShipDesignComponents[0].ComponentValue = 2 }, boundedCargo, 'Integer converted extra cargo 0 versus >=1 partitions the capped sum at two people; all boundaries and MaxValue are included.')
example('Sol R3 known non-berth type excludes NULL function', (w) => { w.FCT_ShipDesignComponents[0].ComponentTypeID = 4 }, [['FCT_ShipDesignComponents', 0, 'SpecialFunction', [0, 7]]])
example('Sol R3 known non-berth function excludes NULL type', (w) => { w.FCT_ShipDesignComponents[0].SpecialFunction = 0 }, [['FCT_ShipDesignComponents', 0, 'ComponentTypeID', [0, 17]]])
example('Sol R3 zero count times unknown value', (w) => { w.FCT_ClassComponent[0].NumComponent = 0 }, [['FCT_ShipDesignComponents', 0, 'ComponentValue', [0, 0.1, 1, 2147483647]]], 'Zero count excludes the entire supported value domain.')
example('Sol R3 zero value times unknown count', (w) => { w.FCT_ShipDesignComponents[0].ComponentValue = 0 }, [['FCT_ClassComponent', 0, 'NumComponent', [0, 0.9, 1, 2147483647]]], 'Zero capacity excludes every supported count.')
example('Sol R3 positive capacity alongside unknown component', (w) => extraComponent(w), [['FCT_ClassComponent', 1, 'NumComponent', [0, 0.9, 1, 2147483647]]], 'Readable one-person capacity already saturates the cargo; all additional supported counts have the same occupancy.')
example('full known damage dominates unknown value', (w) => w.FCT_DamagedComponent.push({ GameID: 1, ShipID: 1, ComponentID: 1, Number: 1 }), [['FCT_ShipDesignComponents', 0, 'ComponentValue', [0, 0.1, 1, 2147483647]]], 'Full damage leaves zero undamaged count throughout the supported value domain.')
example('unknown damage jointly bounded by known count', (w) => w.FCT_DamagedComponent.push({ GameID: 1, ShipID: 1, ComponentID: 1, Number: 0 }), [['FCT_DamagedComponent', 0, 'Number', [0, 1]]], 'Loaded damage is an integer in [0,1], exhaustively enumerated.')
example('unknown count constrained by known damage', (w) => { w.FCT_DamagedComponent.push({ GameID: 1, ShipID: 1, ComponentID: 1, Number: 1 }) }, [['FCT_ClassComponent', 0, 'NumComponent', [1, 1.9, 2, 2147483647]]], 'Truncated count must be >=1; count 1 gives zero and >=2 saturates the one-person cargo cap.')
example('NULL Ark flag', () => {}, [['FCT_ShipClass', 0, 'ArkShip', [0, 1]]])
example('explicit unassigned zero', (w) => { w.FCT_Fleet[0].AssignedPopulationID = 0 })
example('NULL assignment preserves same-body alternatives', (w) => extraColony(w), [['FCT_Fleet', 0, 'AssignedPopulationID', [0, 1, 2, 999]]], 'Assignment resolves to self, another same-body colony, unassigned or another-body/absent equivalence. New same-body assignees are also enumerated by the completed oracle.')
example('held same-body foreign assignee', (w) => { extraColony(w, { RaceID: 8 }); w.FCT_Fleet[0].AssignedPopulationID = 2 })
example('ambiguous new assignment', (w) => { extraColony(w); w.FCT_Fleet[0].AssignedPopulationID = 0 })
example('ambiguous assignment cannot change positive surface gate', (w) => { extraColony(w); w.FCT_Fleet[0].AssignedPopulationID = 0; w.FCT_Population[0].Population = 0.0000001 })
example('resolved another-body assignment permits reassignment', (w) => { extraColony(w, { SystemBodyID: 2, RaceID: 8 }); w.FCT_SystemBody.push({ GameID: 1, SystemBodyID: 2, Xcor: 10, Ycor: 10 }); w.FCT_Fleet[0].AssignedPopulationID = 2 })
example('NULL colony race conditional census excludes foreign fleets', (w) => { w.FCT_Fleet.push({ ...w.FCT_Fleet[0], FleetID: 2, RaceID: 8 }); extraShip(w, 2) }, [['FCT_Population', 0, 'RaceID', [7, 8]]])
example('known foreign colony omitted', (w) => extraColony(w, { RaceID: 8 }))
example('existing species', () => {})
example('guarded missing species excludes cargo', (w) => { w.FCT_ShipCargo[0].SpeciesID = 999 })
example('NULL species chooses existing or absent once', () => {}, [['FCT_ShipCargo', 0, 'SpeciesID', [1, 999]]])
example('guarded dangling ship excludes cargo', (w) => { w.FCT_ShipCargo[0].ShipID = 999 })
example('empty cargo read is exact zero', (w) => { w.FCT_ShipCargo = [] })
example('empty components read is exact zero', (w) => { w.FCT_ClassComponent = [] })
example('correlated cargo link chooses one ship before fleet truncation', (w) => { extraShip(w); w.FCT_ShipCargo = [w.FCT_ShipCargo[0]]; w.FCT_ShipDesignComponents[0].ComponentValue = 0.6 }, [['FCT_ShipCargo', 0, 'ShipID', [1, 2, 999]]], 'One row chooses one existing ship or absent reference, never two independent copies; each destination is exhaustively enumerated.')
example('correlated earlier damage component link retains first match', (w) => { extraComponent(w); w.FCT_ShipCargo[0].Amount = 2; w.FCT_DamagedComponent.push({ GameID: 1, ShipID: 1, ComponentID: 1, Number: 1 }, { GameID: 1, ShipID: 1, ComponentID: 1, Number: 0 }) }, [['FCT_DamagedComponent', 0, 'ComponentID', [1, 2, 999]]], 'The earlier row chooses one component or a guarded absent definition. Later first-match selection follows that choice.')
example('unknown row link decisive zero', (w) => { extraShip(w); w.FCT_ShipCargo = [w.FCT_ShipCargo[0]]; w.FCT_ShipCargo[0].Amount = 0 }, [['FCT_ShipCargo', 0, 'ShipID', [1, 2, 999]]])
for (const axis of ['Xcor', 'Ycor']) for (const value of [-1.0000000000000002, -1, -0.9999999999999999, 0.9999999999999999, 1, 1.0000000000000002]) example(`strict tolerance ${axis} ${value}`, (w) => { w.FCT_Fleet[0][axis] = value })
example('failing X excludes unread Y', (w) => { w.FCT_Fleet[0].Xcor = 1 }, [['FCT_Fleet', 0, 'Ycor', [0, 100]]], 'One failing axis excludes all finite completions on the other axis.')
example('cross-system equal coordinates count', (w) => { w.FCT_Fleet[0].SystemID = 999 })
example('ordered excludes unread position', (w) => { w.FCT_MoveOrders.push({ GameID: 1, FleetID: 1 }) }, [['FCT_Fleet', 0, 'Xcor', [0, 100]]])
example('civilian excludes unread position', (w) => { w.FCT_Fleet[0].CivilianFunction = 1 }, [['FCT_Fleet', 0, 'Xcor', [0, 100]]])
example('non-Ark excludes unread cargo', (w) => { w.FCT_ShipClass[0].ArkShip = 0 }, [['FCT_ShipCargo', 0, 'Amount', [0, 1, 2147483647]]])
example('wrong race excludes unread position', (w) => { w.FCT_Fleet[0].RaceID = 8 }, [['FCT_Fleet', 0, 'Xcor', [0, 100]]])
example('decimal class count truncates before damage', (w) => { w.FCT_ClassComponent[0].NumComponent = 1.9; w.FCT_ShipDesignComponents[0].ComponentValue = 2; w.FCT_DamagedComponent.push({ GameID: 1, ShipID: 1, ComponentID: 1, Number: 1 }) })
example('only first duplicate damage row counts', (w) => { w.FCT_DamagedComponent.push({ GameID: 1, ShipID: 1, ComponentID: 1, Number: 0 }, { GameID: 1, ShipID: 1, ComponentID: 1, Number: 1 }) })
example('ten decimal tenth-person modules in one ship', (w) => { w.FCT_ShipDesignComponents[0].ComponentValue = 0.1; for (let id = 2; id <= 10; id++) extraComponent(w, { ComponentID: id }, { SDComponentID: id, ComponentValue: 0.1 }) })
example('ten tenth-person ships truncate once in one fleet', (w) => { w.FCT_ShipDesignComponents[0].ComponentValue = 0.1; for (let id = 2; id <= 10; id++) extraShip(w) })
example('same tenth-person ships split across fleets truncate separately', (w) => { w.FCT_ShipDesignComponents[0].ComponentValue = 0.1; for (let id = 2; id <= 10; id++) { w.FCT_Fleet.push({ ...w.FCT_Fleet[0], FleetID: id }); extraShip(w, id) } })
example('per-ship caps cannot pool spare berths', (w) => { extraShip(w); w.FCT_ShipCargo[0].Amount = 2; w.FCT_ShipCargo[1].Amount = 0 })
for (const amount of [0.49999999999999994, 0.5, 0.5000000000000001, 1.4999999999999998, 1.5, 1.5000000000000002, 2.4999999999999996, 2.5, 2.5000000000000004, 2147483646.5, 2147483647, 2147483647.4999998]) example(`direct double ties-even ${amount}`, (w) => { w.FCT_ShipCargo[0].Amount = amount; w.FCT_ShipDesignComponents[0].ComponentValue = 2147483647 })
for (const amount of [0.49999999999999994, 0.5, 0.5000000000000001, 1.5]) example(`damage direct double ties-even ${amount}`, (w) => { w.FCT_ClassComponent[0].NumComponent = 2; w.FCT_ShipCargo[0].Amount = 2; w.FCT_DamagedComponent.push({ GameID: 1, ShipID: 1, ComponentID: 1, Number: amount }) })
example('fractional cargo rows convert before summing', (w) => { w.FCT_ShipCargo[0].Amount = 0.5; extraCargo(w, { Amount: 0.5 }) })
example('checked cargo sum at Int32 limit', (w) => { w.FCT_ShipCargo[0].Amount = 2147483646; extraCargo(w, { Amount: 1 }); w.FCT_ShipDesignComponents[0].ComponentValue = 2147483647 })
example('fleet sum at Int32 limit', (w) => { w.FCT_ShipCargo[0].Amount = 2147483647; w.FCT_ShipDesignComponents[0].ComponentValue = 2147483647 })
example('colony sum beyond Int32 is decimal', (w) => { w.FCT_ShipCargo[0].Amount = 2147483647; w.FCT_ShipDesignComponents[0].ComponentValue = 2147483647; w.FCT_Fleet.push({ ...w.FCT_Fleet[0], FleetID: 2 }); extraShip(w, 2); w.FCT_ShipCargo[1].Amount = 2147483647 })
example('total zero', (w) => { w.FCT_ShipCargo[0].Amount = 0 })
example('positive sub-person surface', (w) => { w.FCT_ShipCargo[0].Amount = 0; w.FCT_Population[0].Population = 0.0000001 })
example('surface 0.4M plus orbit 0.6M', (w) => { w.FCT_Population[0].Population = 0.4; w.FCT_ShipCargo[0].Amount = 600000; w.FCT_ShipDesignComponents[0].ComponentValue = 600000 })
example('exact one million surface', (w) => { w.FCT_Population[0].Population = 1 })
example('surface million independent of unknown orbit', (w) => { w.FCT_Population[0].Population = 1 }, [['FCT_ShipClass', 0, 'ArkShip', [0, 1]]])
example('known below-threshold upper bound', (w) => { w.FCT_Population[0].Population = 0.999998 }, [['FCT_ShipClass', 0, 'ArkShip', [0, 1]]])
example('correlated ship fleet link changes grouping', (w) => { w.FCT_Fleet.push({ ...w.FCT_Fleet[0], FleetID: 2 }); extraShip(w); w.FCT_ShipDesignComponents[0].ComponentValue = 0.6 }, [['FCT_Ship', 1, 'FleetID', [1, 2, 999]]], 'One ship chooses one fleet or an absent fleet. Group truncation is recomputed after that choice.')
example('correlated body coordinate cannot include distant fleets together', (w) => { w.FCT_Fleet.push({ ...w.FCT_Fleet[0], FleetID: 2, Xcor: 10 }); extraShip(w, 2) }, [['FCT_SystemBody', 0, 'Xcor', [-1, 0, 1, 5, 9, 10, 11]]], 'The shared body coordinate lies inside one of two disjoint strict unit intervals or outside both. Every membership region and boundary is represented.')
example('coincident different bodies have no global fleet winner', (w) => { extraColony(w, { SystemBodyID: 2 }); w.FCT_SystemBody.push({ ...w.FCT_SystemBody[0], SystemBodyID: 2 }); w.FCT_Fleet[0].AssignedPopulationID = 0 })
example('unknown class reference retains known class alternatives', (w) => { w.FCT_ShipClass.push({ GameID: 1, ShipClassID: 2, ArkShip: 0 }) }, [['FCT_Ship', 0, 'ShipClassID', [1, 2]]], 'Known Ark and non-Ark classes attain both endpoints; unresolved definitions cannot exceed the readable one-person cargo cap.')
example('unknown component definition retains readable berth alternative', (w) => { w.FCT_ShipDesignComponents.push({ ...w.FCT_ShipDesignComponents[0], SDComponentID: 2, ComponentTypeID: 4 }) }, [['FCT_ClassComponent', 0, 'ComponentID', [1, 2]]], 'Standard and non-standard definitions attain both endpoints; other unresolved definitions cannot exceed one-person cargo.')
example('unknown quantity preserves shared-count checked-fleet constraint', (w) => { extraShip(w); w.FCT_ShipCargo.forEach((row) => { row.Amount = 2147483647 }); w.FCT_ShipDesignComponents[0].ComponentValue = 1000000000 }, [['FCT_ClassComponent', 0, 'NumComponent', [0, 1]]], 'A shared truncated count is an integer. Count 0 gives zero and count 1 gives two billion people. Every count >=2 exceeds the supported fleet Int32 conversion, so only these two output regions are admissible; clipping to Int32.MaxValue would be unattainable.')
example('relationship alternatives obey joint damage constraints', (w) => { extraShip(w); w.FCT_Ship[1].ShipClassID = 2; w.FCT_ShipClass.push({ GameID: 1, ShipClassID: 2, ArkShip: 1 }); w.FCT_ClassComponent.push({ GameID: 1, ClassID: 2, ComponentID: 1, NumComponent: 2 }); w.FCT_DamagedComponent.push({ GameID: 1, ShipID: 2, ComponentID: 1, Number: 2 }) }, [['FCT_DamagedComponent', 0, 'ShipID', [2, 999]]], 'The row may choose ship 2 or an absent ship. Choosing ship 1 would damage two of its one component and is not an admissible completion; it must not poison the supported alternatives.')
// Fixed seed, with bounded actual enumeration: a few selectors/references at once, quantities always capped by one readable berth.
let seed = 0x31115
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
for (let index = 0; index < 12; index++) example(`seeded small raw world ${index}`, (w) => { w.FCT_Population[0].Population = [0, 0.4, 1][random() % 3]; w.FCT_ShipDesignComponents[0].ComponentValue = [0.1, 0.6, 1][random() % 3]; extraCargo(w) }, [['FCT_ShipCargo', 0, 'CargoTypeID', [0, 1]], ...boundedCargo], cargoPartition)

const FAULTS = [
  { name: 'NULL cargo prefilter', file: 'src/renderer/utilities/orbital-census.js', from: 'if (known(row.CargoTypeID) && row.CargoTypeID !== 1) continue', to: 'if (row.CargoTypeID !== 1) continue' },
  { name: 'readable lower bound erased by unknown extra', file: 'src/renderer/utilities/orbital-census.js', from: 'const cargo = loadedCargo(ship)', to: 'const cargo = related("cargo", ship.ShipID, "ShipID", "ships").some((row) => !known(row.Amount)) ? model.variable("erased lower", "integer", "cargo") : loadedCargo(ship)' },
  { name: 'missing operand beats partial conjunction exclusion', file: 'src/renderer/utilities/orbital-census.js', from: 'if (known(definition.ComponentTypeID) && definition.ComponentTypeID !== 17) continue', to: 'if (!known(definition.SpecialFunction)) terms.push(model.variable("false berth", "integer", "berths")); if (known(definition.ComponentTypeID) && definition.ComponentTypeID !== 17) continue' },
  { name: 'round class count instead of truncating', file: 'src/renderer/utilities/orbital-census.js', from: 'const count = decimal.floor(loaded)', to: 'const count = decimal.round(loaded, 0)' },
  { name: 'truncate each ship instead of the fleet', file: 'src/renderer/utilities/orbital-census.js', from: 'occupants.push(minimum(cargo, capacity(ship, classID, cargo)))', to: 'occupants.push(truncate(minimum(cargo, capacity(ship, classID, cargo))))' },
  { name: 'NULL assignment defaulted to self', file: 'src/renderer/utilities/orbital-census.js', from: 'const assignedHere = (fleet) => {', to: 'const assignedHere = (fleet) => { if (!known(fleet.AssignedPopulationID)) return true' },
  { name: 'system equality added to membership', file: 'src/renderer/utilities/orbital-census.js', from: 'if (!bodyMatches(fleet)) continue', to: 'if (fleet.SystemID !== colony.SystemID || !bodyMatches(fleet)) continue' },
  { name: 'cargo rounded after decimal load', file: 'src/renderer/utilities/orbital-census.js', from: 'const fraction = value - lower', to: 'value = decimal.toNumber(decimal.fromDouble(value)); const fraction = value - lower' },
  { name: 'omit necessary feasible-domain narrowing', file: 'src/renderer/utilities/orbital-census.js', from: 'bounds.set(key, [pair[0], lower])', to: 'bounds.set(key, pair)' },
  { name: 'drop shared constraints at another colony', file: 'src/renderer/utilities/orbital-census.js', from: 'buildOrbital(data, indexes, other, RaceID, choices, model, fleetKeys)', to: 'if (false) buildOrbital(data, indexes, other, RaceID, choices, model, fleetKeys)' },
  { name: 'invalid high profile poisons supported lower', file: 'src/renderer/utilities/orbital-census.js', from: 'const high = supported(profile(null, true))', to: 'const high = supported(profile(null, true)); if (high === null) return null' },
  { name: 'uncertified ceiling hides coupling reason', file: 'src/renderer/utilities/orbital-census.js', from: 'const hiExact = decimal.equal(lo, hi) || (high !== null && decimal.equal(high, hi))', to: 'const hiExact = true' },
  { name: 'replace real ClassID with an invented relationship column', file: 'src/renderer/utilities/orbital-census.js', from: 'FCT_ClassComponent.*', to: 'GameID, ClassID as ShipClassID, ComponentID, NumComponent' },
  { name: 'unrelated fleet invalidity enters another colony', file: 'src/renderer/utilities/orbital-census.js', from: 'if (fleetKeys && !fleetKeys.has(fleet.CensusKey)) continue', to: 'if (false && fleetKeys && !fleetKeys.has(fleet.CensusKey)) continue' },
  { name: 'unrelated Ark flags enter local blockers', file: 'src/renderer/utilities/orbital-census.js', from: 'const localMissing = new Set(model.missing)', to: 'for (const row of data.classes.rows) if (!known(row.ArkShip)) model.missing.add("the Ark ship flag"); const localMissing = new Set(model.missing)' },
  { name: 'infeasible categorical branch poisons supported union', file: 'src/renderer/utilities/orbital-census.js', from: 'else unsupportedOrbit = null', to: 'else if (unsupportedOrbit) return { orbitalPeople: null, totalPopulation: null, unsupported: unsupportedOrbit }' },
  { name: 'zero cargo skips shared feasibility and range validation', file: 'src/renderer/utilities/orbital-census.js', from: 'const cargo = loadedCargo(ship)', to: 'const cargo = loadedCargo(ship); if (cargo === C0) continue' },
  { name: 'categorical blockers by reachability instead of influence', file: 'src/renderer/utilities/orbital-census.js', from: 'if (influential) merged.missing =', to: 'if (true) merged.missing =' },
]

const completionWorlds = function * (test, index = 0, rows = clone(test.rows)) {
  if (index === test.cells.length) { yield rows; return }
  const [table, row, field, domain] = test.cells[index]
  for (const value of domain) {
    const next = clone(rows)
    next[table][row][field] = value
    yield * completionWorlds(test, index + 1, next)
  }
}
const samePredicate = (values) => values.every((value) => value === values[0]) ? values[0] : null
const checkCase = async (census, test) => {
  const result = await planted(census, test.rows)
  let enumerated = 0
  const counts = new Map()
  const totals = new Map()
  for (const completed of completionWorlds(test)) {
    enumerated++
    for (const target of completed.FCT_Population.filter((row) => row.RaceID === 7)) {
      if (!counts.has(target.PopulationID)) { counts.set(target.PopulationID, []); totals.set(target.PopulationID, []) }
      for (const count of completedCounts(completed, target)) {
        counts.get(target.PopulationID).push(integer(count))
        totals.get(target.PopulationID).push(add(rational(target.Population), { n: count, d: 1000000n }))
      }
    }
  }
  assert.ok(enumerated <= 64, `${test.name}: explicitly bounded oracle enumeration`)
  for (const target of test.rows.FCT_Population) {
    const entry = result.get(target.PopulationID)
    if (target.RaceID !== 7 && target.RaceID !== null) { assert.equal(entry, undefined); continue }
    assert.ok(entry, `${test.name}: colony retained`)
    assert.equal(entry.raceMatches, target.RaceID === null ? null : true, `${test.name}: attribution exactness`)
    for (const [field, expected] of [['orbitalPeople', counts.get(target.PopulationID)], ['totalPopulation', totals.get(target.PopulationID)]]) {
      assert.ok(entry[field], `${test.name}: ${field} interval`)
      const lo = decimalRational(entry[field].lo)
      const hi = decimalRational(entry[field].hi)
      for (const value of expected) assert.ok(compare(lo, value) <= 0 && compare(hi, value) >= 0, `${test.name}: containment ${field}`)
      assert.ok(expected.some((value) => compare(lo, value) === 0), `${test.name}: attained lower ${field}`)
      assert.ok(expected.some((value) => compare(hi, value) === 0), `${test.name}: attained upper ${field}`)
      assert.equal(compare(lo, hi) === 0, expected.every((value) => compare(value, expected[0]) === 0), `${test.name}: exactness ${field}`)
    }
    assert.equal(entry.hasPopulation.value, samePredicate(totals.get(target.PopulationID).map((value) => value.n > 0n)), `${test.name}: strict positive predicate exactness`)
    assert.equal(entry.millionEligible.value, samePredicate(totals.get(target.PopulationID).map((value) => compare(value, integer(1n)) >= 0)), `${test.name}: million predicate exactness`)
    for (const predicate of [entry.hasPopulation, entry.millionEligible]) assert.equal(predicate.inputs.missing.length === 0, predicate.value !== null, `${test.name}: only undecided predicates carry missing blockers`)
  }
  return enumerated
}

const unavailableControls = async (census) => {
  const checked = async (name, change, affected = 'orbitalPeople') => {
    const rows = world()
    change(rows)
    const result = (await planted(census, rows)).get(1)
    assert.equal(result[affected], null, `${name}: unsupported interval, not zero or a clamp`)
    assert.equal(result.hasPopulation.value, null, `${name}: unavailable predicate`)
    assert.ok(result.hasPopulation.inputs.missing.length, `${name}: unsupported input named`)
  }
  await checked('negative cargo', (w) => { w.FCT_ShipCargo[0].Amount = -1 })
  await checked('cargo conversion at rejected upper tie', (w) => { w.FCT_ShipCargo[0].Amount = 2147483647.5 })
  await checked('checked per-ship cargo overflow', (w) => { w.FCT_ShipCargo[0].Amount = 2147483647; extraCargo(w, { Amount: 1 }) })
  await checked('truncated count beyond Int32', (w) => { w.FCT_ClassComponent[0].NumComponent = 2147483648 })
  await checked('damage exceeds count', (w) => { w.FCT_DamagedComponent.push({ GameID: 1, ShipID: 1, ComponentID: 1, Number: 2 }) })
  await checked('fleet sum beyond Int32', (w) => { extraShip(w); w.FCT_ShipCargo[0].Amount = 2147483647; w.FCT_ShipDesignComponents[0].ComponentValue = 2147483647 })
  await checked('negative component value', (w) => { w.FCT_ShipDesignComponents[0].ComponentValue = -1 })
  await checked('decimal load overflow', (w) => { w.FCT_ShipDesignComponents[0].ComponentValue = 2 ** 96 })
  await checked('decimal product overflow', (w) => { w.FCT_ClassComponent[0].NumComponent = 2147483647; w.FCT_ShipDesignComponents[0].ComponentValue = 1e28 })
  await checked('unsupported surface', (w) => { w.FCT_Population[0].Population = -1 }, 'totalPopulation')
  await checked('malformed unchecked identity', (w) => { w.FCT_Ship[0].ShipClassID = -1 })
  await checked('duplicate fleet identity', (w) => { w.FCT_Fleet.push({ ...w.FCT_Fleet[0] }) })
  await checked('zero count does not hide known excess damage', (w) => { w.FCT_ClassComponent[0].NumComponent = 0; w.FCT_DamagedComponent.push({ GameID: 1, ShipID: 1, ComponentID: 1, Number: 1 }) })
  await checked('zero value does not hide known count overflow', (w) => { w.FCT_ClassComponent[0].NumComponent = 2147483648; w.FCT_ShipDesignComponents[0].ComponentValue = 0 })
  await checked('zero count does not hide known value overflow', (w) => { w.FCT_ClassComponent[0].NumComponent = 0; w.FCT_ShipDesignComponents[0].ComponentValue = 2 ** 96 })
  await checked('nonfinite cargo', (w) => { w.FCT_ShipCargo[0].Amount = Infinity })
  await checked('nonfinite fleet position', (w) => { w.FCT_Fleet[0].Xcor = Infinity })
  await checked('nonfinite body position', (w) => { w.FCT_SystemBody[0].Xcor = Infinity })
  await checked('malformed species identity', (w) => { w.FCT_Species[0].SpeciesID = null })
  await checked('malformed colony race identity', (w) => { w.FCT_Population[0].RaceID = -1 })
  const base = world()
  await assert.rejects(() => planted(census, base, ['FCT_Population']), /FCT_Population/, 'roster read failure rejects, never an empty census')
  for (const table of ['FCT_ShipCargo', 'FCT_ClassComponent', 'FCT_DamagedComponent', 'FCT_MoveOrders', 'FCT_Species', 'FCT_ShipClass', 'FCT_ShipDesignComponents', 'FCT_SystemBody', 'FCT_Fleet', 'FCT_Ship']) {
    const result = (await planted(census, base, [table])).get(1)
    assert.deepEqual(result.orbitalPeople.lo, { m: 0n, s: 0 }, `failed ${table}: unknown lower`)
    assert.deepEqual(result.orbitalPeople.hi, { m: 1n, s: 0 }, `failed ${table}: tighter readable upper`)
  }
  for (const table of ['FCT_ShipClass', 'FCT_ShipDesignComponents', 'FCT_SystemBody']) {
    const rows = world()
    rows[table] = []
    const result = (await planted(census, rows)).get(1)
    assert.deepEqual(result.orbitalPeople.lo, { m: 0n, s: 0 }, `unresolved ${table}: not a convenient default`)
    assert.deepEqual(result.orbitalPeople.hi, { m: 1n, s: 0 }, `unresolved ${table}: readable cargo upper retained`)
  }
  const decimalConversion = world()
  decimalConversion.FCT_ClassComponent[0].NumComponent = 0.9999999999999999
  assert.deepEqual((await planted(census, decimalConversion)).get(1).orbitalPeople.lo, { m: 1n, s: 0 }, 'class count fromDouble rounds to literal decimal 1 before truncation')
  const count = world()
  count.FCT_ClassComponent[0].NumComponent = 2147483647.9
  count.FCT_ShipCargo[0].Amount = 2147483647
  assert.deepEqual((await planted(census, count)).get(1).orbitalPeople.lo, { m: 2147483647n, s: 0 }, 'fractional count below the truncation overflow boundary is supported')
  console.log('PASS unsupported states, optional read failures and literal decimal conversions')
}

// AE-311-H1-AMEND1: analytic coupled controls, not numeric production searches or billions of oracle completions.
const amendmentControls = async (census) => {
  const reported = world()
  extraShip(reported)
  extraComponent(reported, { NumComponent: null }, { ComponentValue: 2 })
  reported.FCT_ClassComponent[0].NumComponent = null
  reported.FCT_ShipCargo.forEach((row) => { row.Amount = Number(INT) })
  const result = (await planted(census, reported)).get(1)
  assert.ok(result.orbitalPeople, 'AMEND1 an invalid high profile does not erase a supported minimum')
  assert.deepEqual(result.orbitalPeople.lo, { m: 0n, s: 0 }, 'AMEND1 reported world exact compatible minimum')
  assert.deepEqual(result.orbitalPeople.hi, { m: INT, s: 0 }, 'AMEND1 sound outward ceiling; true even maximum is Int32.MaxValue-1')
  assert.equal(result.hasPopulation.value, null)
  assert.equal(result.millionEligible.value, null)
  assert.match(result.hasPopulation.inputs.missing.join(' '), /together.*range|joint.*range/, 'AMEND1 unsupported-range coupling is disclosed, not called a known-invalid state')
  const zero = world()
  extraShip(zero)
  zero.FCT_ClassComponent[0].NumComponent = null
  zero.FCT_ShipDesignComponents[0].ComponentValue = Number(INT)
  zero.FCT_ShipCargo.forEach((row) => { row.Amount = Number(INT) })
  const narrowed = (await planted(census, zero)).get(1)
  assert.deepEqual(narrowed.orbitalPeople, { lo: { m: 0n, s: 0 }, hi: { m: 0n, s: 0 }, missing: [] }, 'AMEND1 narrowing proves a shared count must be zero')
  assert.equal(narrowed.hasPopulation.value, false)
  assert.equal(narrowed.millionEligible.value, false)
  const trade = world()
  extraShip(trade)
  trade.FCT_Ship[1].ShipClassID = 2
  trade.FCT_ShipClass.push({ GameID: 1, ShipClassID: 2, ArkShip: 1 }, { GameID: 1, ShipClassID: 3, ArkShip: 1 })
  trade.FCT_ClassComponent[0].NumComponent = null
  trade.FCT_ClassComponent.push({ GameID: 1, ClassID: 2, ComponentID: 1, NumComponent: null }, { GameID: 1, ClassID: 3, ComponentID: 2, NumComponent: 1 })
  trade.FCT_ShipDesignComponents.push({ GameID: 0, SDComponentID: 2, ComponentTypeID: 17, SpecialFunction: 7, ComponentValue: Number(INT - 500n) })
  extraColony(trade, { SystemBodyID: 2, Population: 0 })
  trade.FCT_SystemBody.push({ GameID: 1, SystemBodyID: 2, Xcor: 10, Ycor: 0 })
  trade.FCT_Fleet.push({ ...trade.FCT_Fleet[0], FleetID: 2, AssignedPopulationID: 2, Xcor: 10 })
  extraShip(trade, 2)
  extraShip(trade, 2)
  extraShip(trade, 2)
  trade.FCT_Ship[3].ShipClassID = 2
  trade.FCT_Ship[4].ShipClassID = 3
  trade.FCT_ShipCargo.forEach((row) => { row.Amount = Number(INT) })
  trade.FCT_ShipCargo[4].Amount = Number(INT - 500n)
  trade.FCT_Population[0].Population = 0.99925
  const coupled = (await planted(census, trade)).get(1)
  assert.deepEqual(coupled.orbitalPeople.lo, { m: 0n, s: 0 })
  assert.deepEqual(coupled.orbitalPeople.hi, { m: 1000n, s: 0 }, 'AMEND1 other-colony shared fleet constrains each unknown count to 500')
  assert.equal(coupled.hasPopulation.value, true)
  assert.equal(coupled.millionEligible.value, null, 'AMEND1 permits disclosed incompleteness: true maximum 500 orbital people stays below one million total')
  assert.match(coupled.millionEligible.inputs.missing.join(' '), /together.*range|joint.*range/)
  const infeasible = clone(zero)
  infeasible.FCT_ClassComponent[0].NumComponent = 1
  assert.equal((await planted(census, infeasible)).get(1).orbitalPeople, null, 'AMEND1 known-infeasible minimum is unsupported, never zero')
  const damaged = world()
  extraShip(damaged)
  damaged.FCT_ClassComponent[0].NumComponent = null
  damaged.FCT_ShipCargo.forEach((row) => { row.Amount = 2 })
  damaged.FCT_DamagedComponent.push({ GameID: 1, ShipID: 1, ComponentID: 1, Number: 1 })
  const minimum = (await planted(census, damaged)).get(1)
  // The first ship's known damage forces the shared count >=1, so the undamaged second ship supplies at least one person. The all-zero profile is not admissible.
  assert.deepEqual(minimum.orbitalPeople.lo, { m: 1n, s: 0 }, 'AMEND1 shared known damage imposes a compatible nonzero minimum')
  assert.equal(minimum.hasPopulation.value, true)
  console.log('PASS AMEND1 reported resource, shared-count zero, cross-colony joint trade-off, and infeasible-minimum controls; retained known-damage lower profile')
}

// Reviewer regressions use the same public raw-SQLite seam as the retained completion matrix.
const schemaControls = async (census) => {
  const rows = world()
  const counted = (await planted(census, rows)).get(1)
  assert.deepEqual(counted.orbitalPeople, { lo: { m: 1n, s: 0 }, hi: { m: 1n, s: 0 }, missing: [] }, 'Sol schema: the real ClassID relationship counts the known berth')
  assert.equal(counted.hasPopulation.value, true)
  rows.FCT_ClassComponent.push({ GameID: 1, ClassID: 2, ComponentID: 1, NumComponent: 2 })
  rows.FCT_ShipClass.push({ GameID: 1, ShipClassID: 2, ArkShip: 1 })
  rows.FCT_ShipCargo[0].Amount = 10
  const separate = (await planted(census, rows)).get(1)
  assert.deepEqual(separate.orbitalPeople.lo, { m: 1n, s: 0 }, 'Sol schema: another class using the same definition does not donate its components')
  assert.deepEqual(separate.orbitalPeople.hi, { m: 1n, s: 0 })
  console.log('PASS Sol real-schema counted class and separate class with shared definition')
}

const exactOne = (entry, name) => {
  assert.deepEqual(entry.orbitalPeople, { lo: { m: 1n, s: 0 }, hi: { m: 1n, s: 0 }, missing: [] }, `${name}: supported alternatives retain exactly one orbital person`)
  assert.equal(entry.hasPopulation.value, true, `${name}: positive total`)
  assert.equal(entry.millionEligible.value, false, `${name}: below one million`)
  assert.equal(compare(decimalRational(entry.totalPopulation.lo), rational(0.000001)), 0, `${name}: total lower`)
  assert.equal(compare(decimalRational(entry.totalPopulation.hi), rational(0.000001)), 0, `${name}: total upper`)
}
const duplicateAlternative = async (census) => {
  const rows = world()
  extraComponent(rows, { ComponentID: null, NumComponent: 0 })
  exactOne((await planted(census, rows)).get(1), 'Sol nullable duplicate reference')
  rows.FCT_ClassComponent[1].ComponentID = 2
  exactOne((await planted(census, rows)).get(1), 'Sol completed unique reference')
  rows.FCT_ClassComponent[1].ComponentID = 1
  assert.equal((await planted(census, rows)).get(1).orbitalPeople, null, 'Sol all duplicate alternatives infeasible remains unsupported')
  console.log('PASS Sol infeasible duplicate alternative, supported unique completion and all-infeasible control')
}
const categoryAlternative = async (census) => {
  const rows = world()
  extraCargo(rows, { CargoTypeID: null, Amount: 2147483647.5 })
  exactOne((await planted(census, rows)).get(1), 'Sol infeasible colonist selector')
  rows.FCT_ShipCargo[1].CargoTypeID = 1
  assert.equal((await planted(census, rows)).get(1).totalPopulation, null, 'Sol all selector alternatives infeasible remains unsupported')
  console.log('PASS Sol infeasible cargo-category alternative and all-infeasible control')
}

const zeroSharedCount = async (census) => {
  const rows = world()
  extraShip(rows)
  rows.FCT_ClassComponent[0].NumComponent = null
  rows.FCT_ShipCargo[0].Amount = 0
  rows.FCT_DamagedComponent.push({ GameID: 1, ShipID: 1, ComponentID: 1, Number: 1 })
  exactOne((await planted(census, rows)).get(1), 'Sol zero cargo retains shared known-damage constraint')
  for (const count of [1, 1.9, 2, 2147483647]) {
    rows.FCT_ClassComponent[0].NumComponent = count
    exactOne((await planted(census, rows)).get(1), `Sol zero cargo supported count ${count}`)
  }
  const unknown = world()
  unknown.FCT_ShipCargo[0].Amount = 0
  unknown.FCT_ClassComponent[0].NumComponent = null
  unknown.FCT_ShipDesignComponents[0].ComponentValue = null
  unknown.FCT_DamagedComponent.push({ GameID: 1, ShipID: 1, ComponentID: 1, Number: null })
  assert.deepEqual((await planted(census, unknown)).get(1).orbitalPeople, { lo: { m: 0n, s: 0 }, hi: { m: 0n, s: 0 }, missing: [] }, 'Sol unknown capacity with zero cargo stays decisive zero')
  console.log('PASS Sol zero-cargo shared-count minimum, completed counts and decisive unknown-capacity zero')
}
const zeroInvalid = (kind) => async (census) => {
  const rows = world()
  rows.FCT_ShipCargo[0].Amount = 0
  if (kind === 'count') rows.FCT_ClassComponent[0].NumComponent = 2147483648
  if (kind === 'value') rows.FCT_ShipDesignComponents[0].ComponentValue = 2 ** 96
  if (kind === 'damage') rows.FCT_DamagedComponent.push({ GameID: 1, ShipID: 1, ComponentID: 1, Number: 2 })
  const result = (await planted(census, rows)).get(1)
  assert.equal(result.orbitalPeople, null, `Sol zero cargo does not hide known-invalid ${kind}`)
  assert.equal(result.totalPopulation, null)
  assert.equal(result.hasPopulation.value, null)
  assert.equal(result.millionEligible.value, null)
  console.log(`PASS Sol zero-cargo invalid ${kind}`)
}

const remoteColony = (rows) => {
  extraColony(rows, { SystemBodyID: 2 })
  rows.FCT_SystemBody.push({ GameID: 1, SystemBodyID: 2, Xcor: 10, Ycor: 0 })
  rows.FCT_Fleet.push({ ...rows.FCT_Fleet[0], FleetID: 2, AssignedPopulationID: 2, Xcor: 10 })
  extraShip(rows, 2)
  rows.FCT_Ship[1].ShipClassID = 2
  rows.FCT_ShipClass.push({ GameID: 1, ShipClassID: 2, ArkShip: 1 })
  rows.FCT_ClassComponent.push({ GameID: 1, ClassID: 2, ComponentID: 1, NumComponent: 1 })
}
const localUnknown = (entry, name) => {
  assert.ok(entry.orbitalPeople, `${name}: independent colony retains its supported interval`)
  assert.deepEqual(entry.orbitalPeople.lo, { m: 0n, s: 0 }, `${name}: lower`)
  assert.deepEqual(entry.orbitalPeople.hi, { m: 1n, s: 0 }, `${name}: upper`)
  assert.equal(entry.hasPopulation.value, null)
  assert.equal(entry.millionEligible.value, false)
  for (const missing of [entry.orbitalPeople.missing, entry.totalPopulation.missing, entry.hasPopulation.inputs.missing]) assert.deepEqual(missing, ['the colonist cargo amount'], `${name}: only locally influential cells are blockers`)
}
const unrelatedInvalid = async (census) => {
  const rows = world()
  rows.FCT_ShipCargo[0].Amount = null
  remoteColony(rows)
  rows.FCT_ShipCargo[1].Amount = -1
  const result = await planted(census, rows)
  localUnknown(result.get(1), 'Terra unrelated invalid cargo')
  assert.equal(result.get(2).orbitalPeople, null, 'Terra invalid remote colony remains unsupported itself')
  console.log('PASS Terra unrelated known-invalid colony cannot erase a local census')
}
const unrelatedBlocker = async (census) => {
  const rows = world()
  rows.FCT_ShipCargo[0].Amount = null
  remoteColony(rows)
  rows.FCT_ShipClass[1].ArkShip = null
  localUnknown((await planted(census, rows)).get(1), 'Terra unrelated Ark flag')
  rows.FCT_ShipClass[1].ArkShip = 1
  rows.FCT_ShipCargo[1].Amount = null
  localUnknown((await planted(census, rows)).get(1), 'Terra unrelated unknown cargo')
  console.log('PASS Terra unrelated categorical and numeric cells never enter local blockers')
}

const sharedLocality = async (census) => {
  const rows = world()
  rows.FCT_ClassComponent[0].NumComponent = null
  remoteColony(rows)
  rows.FCT_Ship[1].ShipClassID = 1
  rows.FCT_ShipCargo[1].Amount = 0
  rows.FCT_DamagedComponent.push({ GameID: 1, ShipID: 2, ComponentID: 1, Number: 1 })
  rows.FCT_Fleet.push({ ...rows.FCT_Fleet[1], FleetID: 3 })
  extraShip(rows, 3)
  rows.FCT_Ship[2].ShipClassID = 2
  rows.FCT_ShipCargo[2].Amount = -1
  exactOne((await planted(census, rows)).get(1), 'Locality: shared zero-cargo damage reaches A, independent invalid fleet at B does not')
  rows.FCT_Fleet[1].RaceID = null
  const conditional = (await planted(census, rows)).get(1)
  assert.deepEqual(conditional.orbitalPeople.lo, { m: 0n, s: 0 }, 'Locality: an excluded shared fleet cannot force the count minimum')
  assert.deepEqual(conditional.orbitalPeople.hi, { m: 1n, s: 0 })
  for (const [race, lower] of [[7, 1n], [8, 0n]]) {
    rows.FCT_Fleet[1].RaceID = race
    const completed = (await planted(census, rows)).get(1)
    assert.deepEqual(completed.orbitalPeople.lo, { m: lower, s: 0 }, 'Locality: membership alternatives carry their own shared constraints')
    assert.deepEqual(completed.orbitalPeople.hi, { m: 1n, s: 0 })
  }
  console.log('PASS shared-cell reachability isolates fleets within a remote colony and respects nullable membership')
}

const influenceLocality = async (census) => {
  const rows = world()
  rows.FCT_Population[0].Population = 0.9999985
  rows.FCT_ClassComponent[0].NumComponent = null
  rows.FCT_ShipCargo[0].Amount = 2
  remoteColony(rows)
  rows.FCT_Ship[1].ShipClassID = 1
  rows.FCT_ShipCargo[1].Amount = 0
  rows.FCT_DamagedComponent.push({ GameID: 1, ShipID: 2, ComponentID: 1, Number: 1 })
  rows.FCT_Population.push({ ...rows.FCT_Population[0], PopulationID: 3, SystemBodyID: 3 })
  rows.FCT_SystemBody.push({ GameID: 1, SystemBodyID: 3, Xcor: 40, Ycor: 0 })
  let expected
  for (const race of [7, 8, null]) {
    rows.FCT_Population[2].RaceID = race
    const entry = (await planted(census, rows)).get(1)
    assert.deepEqual(entry.orbitalPeople, { lo: { m: 1n, s: 0 }, hi: { m: 2n, s: 0 }, missing: ['the standard berth component count'] }, 'Sol R4: a real external constraint cannot make a disconnected race influential')
    assert.equal(compare(decimalRational(entry.totalPopulation.lo), rational('0.9999995')), 0)
    assert.equal(compare(decimalRational(entry.totalPopulation.hi), rational('1.0000005')), 0)
    assert.equal(entry.hasPopulation.value, true)
    assert.equal(entry.millionEligible.value, null)
    assert.deepEqual(entry.totalPopulation.missing, ['the standard berth component count'])
    assert.deepEqual(entry.millionEligible.inputs.missing, ['the standard berth component count'])
    if (expected) assert.deepEqual(entry, expected, 'Sol R4: selected, foreign and NULL disconnected race give identical results and explanations')
    expected = entry
  }
  // Reachability alone is insufficient: this same-class zero-cargo ship adds no damage lower bound or checked ceiling.
  rows.FCT_Fleet.push({ ...rows.FCT_Fleet[0], FleetID: 3, AssignedPopulationID: 3, Xcor: 40 })
  extraShip(rows, 3)
  rows.FCT_ShipCargo[2].Amount = 0
  assert.deepEqual((await planted(census, rows)).get(1), expected, 'Sol R4: a reachable but non-influential colony race is not a blocker')
  rows.FCT_Population[1].RaceID = null
  const influential = (await planted(census, rows)).get(1)
  assert.deepEqual(influential.orbitalPeople.lo, { m: 0n, s: 0 })
  assert.deepEqual(influential.orbitalPeople.hi, { m: 2n, s: 0 })
  for (const missing of [influential.orbitalPeople.missing, influential.totalPopulation.missing, influential.millionEligible.inputs.missing]) assert.ok(missing.includes('the race of another colony'), 'Sol R4: genuinely influential external membership retains its blocker')
  console.log('PASS Sol R4 disconnected and reachable non-influential races excluded; influential external membership retained')
}

const transitiveLocality = async (census) => {
  const rows = world()
  rows.FCT_ClassComponent[0].NumComponent = null
  rows.FCT_ShipCargo[0].Amount = Number(INT)
  for (const [id, x] of [[2, 10], [3, 20]]) {
    rows.FCT_Population.push({ ...rows.FCT_Population[0], PopulationID: id, SystemBodyID: id })
    rows.FCT_SystemBody.push({ ...rows.FCT_SystemBody[0], SystemBodyID: id, Xcor: x })
    rows.FCT_Fleet.push({ ...rows.FCT_Fleet[0], FleetID: id, AssignedPopulationID: id, Xcor: x })
  }
  rows.FCT_ShipClass.push({ GameID: 1, ShipClassID: 2, ArkShip: 1 }, { GameID: 1, ShipClassID: 3, ArkShip: 1 }, { GameID: 1, ShipClassID: 4, ArkShip: 1 })
  rows.FCT_ClassComponent.push({ GameID: 1, ClassID: 2, ComponentID: 1, NumComponent: null }, { GameID: 1, ClassID: 3, ComponentID: 2, NumComponent: 1 }, { GameID: 1, ClassID: 4, ComponentID: 3, NumComponent: 1 })
  rows.FCT_ShipDesignComponents.push({ GameID: 0, SDComponentID: 2, ComponentTypeID: 17, SpecialFunction: 7, ComponentValue: Number(INT) - 2 }, { GameID: 0, SDComponentID: 3, ComponentTypeID: 17, SpecialFunction: 7, ComponentValue: 1 })
  for (const [id, fleet, shipClass, amount] of [[2, 2, 1, Number(INT)], [3, 2, 2, Number(INT)], [4, 2, 3, Number(INT) - 2], [5, 3, 2, 0]]) {
    rows.FCT_Ship.push({ ...rows.FCT_Ship[0], ShipID: id, FleetID: fleet, ShipClassID: shipClass })
    extraCargo(rows, { ShipID: id, Amount: amount })
  }
  rows.FCT_DamagedComponent.push({ GameID: 1, ShipID: 5, ComponentID: 1, Number: 1 })
  rows.FCT_Fleet.push({ ...rows.FCT_Fleet[1], FleetID: 4 })
  rows.FCT_Ship.push({ ...rows.FCT_Ship[0], ShipID: 6, FleetID: 4, ShipClassID: 4 })
  extraCargo(rows, { ShipID: 6, Amount: -1 })
  // B requires a+b<=2; selected C requires b>=1. Endpoints are (0,1), (1,1), or (2,0) when C is excluded.
  for (const [race, upper] of [[7, 1n], [8, 2n], [null, 2n]]) {
    rows.FCT_Fleet[2].RaceID = race
    const entry = (await planted(census, rows)).get(1)
    assert.deepEqual(entry.orbitalPeople.lo, { m: 0n, s: 0 })
    assert.deepEqual(entry.orbitalPeople.hi, { m: upper, s: 0 }, 'Sol transitive locality: shared damage reaches A through B')
    assert.equal(entry.millionEligible.value, false)
  }
  rows.FCT_Fleet[2].RaceID = 7
  const expected = (await planted(census, rows)).get(1)
  rows.FCT_Population.push({ ...rows.FCT_Population[0], PopulationID: 4, SystemBodyID: 4, RaceID: null })
  rows.FCT_SystemBody.push({ ...rows.FCT_SystemBody[0], SystemBodyID: 4, Xcor: 40 })
  assert.deepEqual((await planted(census, rows)).get(1), expected, 'Sol transitive locality: a disconnected nullable race changes neither result nor missing inputs')
  assert.ok(!expected.hasPopulation.inputs.missing.includes('the race of another colony'))
  console.log('PASS Sol transitive shared-cell constraints, nullable fleet membership, independent invalid fleet and disconnected colony locality')
}

const playedSmoke = async (census) => {
  for (const [name, fixture] of [['A', PLAYED], ['B', PLAYED_NEXT], ['C1', PLAYED_C1], ['C2', PLAYED_C2]]) {
    const raw = new Database(path.resolve(__dirname, '..', fixture.file), { readonly: true })
    try {
      const result = await census.loadOrbitalCensus({ query: async (sql) => [raw.query(sql).all()] }, { GameID: fixture.gameId, RaceID: fixture.raceId })
      assert.ok(result.size, `${name}: played colony roster loads`)
      for (const entry of result.values()) {
        for (const field of ['orbitalPeople', 'totalPopulation']) {
          const interval = entry[field]
          assert.ok(interval, `${name}: ${field} is supported`)
          for (const endpoint of [interval.lo, interval.hi]) assert.ok(typeof endpoint.m === 'bigint' && endpoint.m >= 0n && Number.isInteger(endpoint.s) && endpoint.s >= 0 && endpoint.s <= 28, `${name}: finite nonnegative decimal endpoint`)
          assert.ok(compare(decimalRational(interval.lo), decimalRational(interval.hi)) <= 0, `${name}: ${field} endpoints ordered`)
        }
      }
      console.log(`PASS played-save ${name}: loader and supported ordered intervals (no census figure oracle)`)
    } finally { raw.close() }
  }
}

const run = async () => {
  const faultIndex = process.argv.find((argument) => argument.startsWith('--fault='))
  const fault = faultIndex ? FAULTS[Number(faultIndex.split('=')[1])] : null
  const sources = fault ? { 'orbital-census': plantedPatch(fault.file, fs.readFileSync(path.resolve(__dirname, '..', fault.file), 'utf8'), fault.from, fault.to) } : {}
  const { 'orbital-census': census } = await loadUtilities(['orbital-census'], { sources })
  const probe = process.argv.find((argument) => argument.startsWith('--probe='))
  if (probe) {
    const controls = { schema: schemaControls, duplicate: duplicateAlternative, category: categoryAlternative, 'zero-shared': zeroSharedCount, 'zero-count': zeroInvalid('count'), 'zero-value': zeroInvalid('value'), 'zero-damage': zeroInvalid('damage'), 'unrelated-invalid': unrelatedInvalid, 'unrelated-blocker': unrelatedBlocker, influence: influenceLocality, transitive: transitiveLocality }
    await controls[probe.split('=')[1]](census)
    return
  }
  await schemaControls(census)
  await duplicateAlternative(census)
  await categoryAlternative(census)
  await zeroSharedCount(census)
  for (const kind of ['count', 'value', 'damage']) await zeroInvalid(kind)(census)
  await unrelatedInvalid(census)
  await unrelatedBlocker(census)
  await sharedLocality(census)
  await influenceLocality(census)
  await transitiveLocality(census)
  if (!fault) await playedSmoke(census)
  let worlds = 0
  const started = performance.now()
  for (const test of cases) { worlds += await checkCase(census, test); console.log(`PASS ${test.name}`) }
  await unavailableControls(census)
  await amendmentControls(census)
  console.log(`ORACLE ${cases.length} cases, ${worlds} completed raw worlds, ${Math.round(performance.now() - started)} ms; fixed seed 0x31115; rational partition premise in each case.`)
  if (!fault && mutating()) {
    for (let index = 0; index < FAULTS.length; index++) {
      const child = await runChild(__filename, [`--fault=${index}`], { limit: 60000 })
      assert.ok(!child.timedOut && child.code !== 0 && /AssertionError/.test(child.stderr), `valid mutant caught: ${FAULTS[index].name}: ${child.stderr.slice(-1000)}`)
      console.log(`CAUGHT ${FAULTS[index].name}`)
    }
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1 })
