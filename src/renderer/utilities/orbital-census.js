// Shared saved-snapshot census of the people aboard stationary Ark fleets and on colony surfaces.
import * as decimal from './decimal'
import { ofRule, registerRule, unavailable } from './provenance'

const RULE = 'population.orbitalCensus'
const INT = 2147483647n
const MAX = { m: (1n << 96n) - 1n, s: 0 }
const MILLION = { m: 1000000n, s: 0 }
const ZERO = decimal.ZERO
const ONE = { m: 1n, s: 0 }
const whole = (m) => ({ m, s: 0 })
const maximum = (a, b) => decimal.compare(a, b) >= 0 ? a : b
const known = (value) => value !== null && value !== undefined
const identity = (value) => Number.isInteger(value) && value > 0 && value <= Number(INT)

// The saved-state assignment estimate does not simulate a later, interleaved population pass.
registerRule({
  id: RULE,
  versions: ['3.2.x'],
  verification: 'estimated',
  units: '',
  structure: ['FCT_Population', 'FCT_SystemBody', 'FCT_Fleet', 'FCT_Ship', 'FCT_ShipClass', 'FCT_ClassComponent', 'FCT_ShipDesignComponents', 'FCT_DamagedComponent', 'FCT_ShipCargo', 'FCT_MoveOrders', 'FCT_Species'],
  note: 'Surface population plus the occupants of stationary, non-civilian Ark fleets at the colony body. Each ship counts loaded colonists up to its undamaged standard berths; whole people are counted separately for each fleet.',
  assumptions: ['The saved positions and assignments are held fixed; advancing the game can change which colony counts a fleet. Unknown saved inputs range over supported, nonnegative completions. Coupled unknown quantities can leave a conservative upper bound and an undecided population gate.'],
})

// Round the binary double itself to nearest/ties-even, not its decimal load conversion. Adjacent doubles on either side of a half stay on their own side.
const integerLoad = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError('unsupported integer quantity')
  const lower = Math.floor(value)
  const fraction = value - lower
  const rounded = lower + (fraction > 0.5 || (fraction === 0.5 && lower % 2 === 1) ? 1 : 0)
  if (rounded > Number(INT)) throw new RangeError('unsupported integer conversion')
  return whole(BigInt(rounded))
}

const decimalLoad = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError('unsupported decimal quantity')
  return decimal.fromDouble(value)
}

// Unknown decimal loads range over nonnegative binary doubles, not arbitrary decimal strings. The largest supported double is below 2^96.
const view = new DataView(new ArrayBuffer(8))
const bitsOf = (value) => { view.setFloat64(0, value); return view.getBigUint64(0) }
const doubleOf = (bits) => { view.setBigUint64(0, bits); return view.getFloat64(0) }
const LAST_DECIMAL_DOUBLE = bitsOf(2 ** 96) - 1n
const constant = (value) => ({ op: 'constant', value })
const C0 = constant(ZERO)
const CI = constant(whole(INT))
const invalid = (name) => { throw new Unsupported(name) }
class Unsupported extends Error {}
class Alternative extends Error {
  constructor(key, options, label) { super(key); this.key = key; this.options = options; this.label = label }
}

// Expressions retain shared numeric cells. Checked sums constrain supported completions, never clamp known invalid data. Lower profiles are attained; an upper is certified only by a compatible supported completion (AMEND1 permits a sound, unattained ceiling otherwise).
const arithmetic = (op, a, b) => ({ op, a, b })
const plus = (a, b) => arithmetic('add', a, b)
const times = (a, b) => arithmetic('multiply', a, b)
const minimum = (a, b) => arithmetic('minimum', a, b)
const minus = (a, b) => arithmetic('subtract', a, b)
const truncate = (a) => ({ op: 'floor', a })
const sum = (terms) => terms.reduce(plus, C0)

const numericModel = () => {
  const variables = new Map()
  const constraints = []
  const missing = new Set()
  const variable = (key, kind, label) => {
    missing.add(label)
    if (!variables.has(key)) variables.set(key, { op: 'variable', key, kind, lo: 0n, hi: kind === 'decimal' ? LAST_DECIMAL_DOUBLE : INT })
    return variables.get(key)
  }
  const quantity = (row, field, kind, label) => {
    if (!known(row[field])) return variable(`${row.CensusKey}.${field}`, kind, label)
    try {
      const loaded = kind === 'integer' ? integerLoad(row[field]) : decimalLoad(row[field])
      if (kind === 'count') {
        const count = decimal.floor(loaded)
        if (count.m > INT) invalid(label)
        return constant(count)
      }
      return constant(loaded)
    } catch (error) {
      if (error instanceof RangeError || error instanceof TypeError) invalid(label)
      throw error
    }
  }
  const atMost = (a, b) => constraints.push([a, b])
  return { variables, constraints, missing, quantity, variable, atMost }
}

const evaluate = (expression, bounds, exact = false, memo = new Map()) => {
  if (memo.has(expression)) return memo.get(expression)
  let result
  if (expression.op === 'constant') {
    result = [expression.value, expression.value]
  } else if (expression.op === 'variable') {
    const [lo, hi] = bounds.get(expression.key)
    const load = (value) => expression.kind === 'decimal' ? decimalLoad(doubleOf(value)) : whole(value)
    result = [load(lo), load(hi)]
  } else {
    const a = evaluate(expression.a, bounds, exact, memo)
    if (expression.op === 'floor') {
      result = a.map(decimal.floor)
    } else {
      const b = evaluate(expression.b, bounds, exact, memo)
      if (expression.op === 'subtract') {
        if (decimal.compare(a[1], b[0]) < 0) throw new RangeError('no supported damage completion')
        if (exact && decimal.compare(a[0], b[0]) < 0) throw new RangeError('excess damage')
        result = [maximum(ZERO, decimal.subtract(a[0], b[1])), decimal.subtract(a[1], b[0])]
      } else if (expression.op === 'minimum') {
        result = [decimal.minimum(a[0], b[0]), decimal.minimum(a[1], b[1])]
      } else {
        const operation = expression.op === 'add' ? decimal.add : expression.op === 'multiply' ? decimal.multiply : decimal.divide
        const lo = operation(a[0], b[0])
        let hi
        try { hi = operation(a[1], b[1]) } catch (error) {
          if (exact || !(error instanceof RangeError)) throw error
          hi = MAX
        }
        result = [lo, hi]
      }
    }
  }
  memo.set(expression, result)
  return result
}

// AE-311-H1-AMEND1: no numeric enumeration or maximum/threshold search. The only bisection is one necessary-feasibility narrowing pass per loaded cell (integer units or ordered nonnegative double bits).
// Occupancy is nondecreasing in cargo, count, value and undamaged activity. Known damage imposes a count lower bound; unknown damage is represented by activity u with 0 <= u <= count. Raising u raises its shared count where necessary. This compatible profile minimizes every other occupancy simultaneously, so failing an upper-domain constraint is a necessary, monotone exclusion for the candidate cell value.
const extrema = (expression, model) => {
  const bounds = new Map([...model.variables].map(([key, variable]) => [key, [variable.lo, variable.hi]]))
  const profile = (candidate = null, high = false) => {
    const values = new Map([...bounds].map(([key, pair]) => [key, high ? pair[1] : pair[0]]))
    if (candidate) values.set(candidate[0], candidate[1])
    // Only activity/count and known-damage/count lower relationships occur here. They have depth one; one pass preserves all shared cells without a convergence loop.
    for (const [a, b] of model.constraints) {
      if (b.op !== 'variable' || (a.op !== 'constant' && a.op !== 'variable')) continue
      const needed = a.op === 'constant' ? a.value.m : values.get(a.key)
      if (values.get(b.key) < needed) {
        if (candidate && candidate[0] === b.key) return null
        values.set(b.key, needed)
      }
    }
    for (const [key, value] of values) {
      const pair = bounds.get(key)
      if (value < pair[0] || value > pair[1]) return null
    }
    return new Map([...values].map(([key, value]) => [key, [value, value]]))
  }
  const supported = (completed) => {
    if (!completed) return null
    try {
      const memo = new Map()
      for (const [a, b] of model.constraints) if (decimal.compare(evaluate(a, completed, true, memo)[0], evaluate(b, completed, true, memo)[0]) > 0) return null
      return evaluate(expression, completed, true, memo)[0]
    } catch (error) { if (error instanceof RangeError) return null; throw error }
  }
  const lo = supported(profile())
  if (lo === null) return null
  for (const [key, pair] of bounds) {
    let lower = pair[0]
    let upper = pair[1]
    while (lower < upper) {
      const middle = (lower + upper + 1n) / 2n
      if (supported(profile([key, middle])) !== null) lower = middle
      else upper = middle - 1n
    }
    bounds.set(key, [pair[0], lower])
  }
  const hi = evaluate(expression, bounds)[1]
  const high = supported(profile(null, true))
  const hiExact = decimal.equal(lo, hi) || (high !== null && decimal.equal(high, hi))
  return { lo, hi, hiExact, missing: decimal.equal(lo, hi) ? [] : [...model.missing] }
}

// No joins or selector filters: NULL classifications and unresolved references cross the same SQL seam as complete rows. rowid is the stable SQLite load-order convention for the first matching damage record.
const acquire = async (database, GameID) => {
  const read = async (table, sql, required = false) => {
    try {
      const [rows] = await database.query(sql)
      return { complete: true, rows: rows.filter((row) => !known(row.GameID) || row.GameID === GameID || (table === 'definitions' && row.GameID === 0)).map((row) => ({ ...row, CensusKey: `${table}:${row.CensusRowID}` })) }
    } catch (error) {
      if (required) throw error
      return { complete: false, rows: [] }
    }
  }
  const [colonies, bodies, fleets, ships, classes, components, definitions, damage, cargo, orders, species] = await Promise.all([
    read('colonies', 'select rowid as CensusRowID, FCT_Population.* from FCT_Population order by rowid', true),
    read('bodies', 'select rowid as CensusRowID, FCT_SystemBody.* from FCT_SystemBody order by rowid'),
    read('fleets', 'select rowid as CensusRowID, FCT_Fleet.* from FCT_Fleet order by rowid'),
    read('ships', 'select rowid as CensusRowID, FCT_Ship.* from FCT_Ship order by rowid'),
    read('classes', 'select rowid as CensusRowID, FCT_ShipClass.* from FCT_ShipClass order by rowid'),
    read('components', 'select rowid as CensusRowID, FCT_ClassComponent.* from FCT_ClassComponent order by rowid'),
    read('definitions', 'select rowid as CensusRowID, FCT_ShipDesignComponents.* from FCT_ShipDesignComponents order by rowid'),
    read('damage', 'select rowid as CensusRowID, FCT_DamagedComponent.* from FCT_DamagedComponent order by rowid'),
    read('cargo', 'select rowid as CensusRowID, FCT_ShipCargo.* from FCT_ShipCargo order by rowid'),
    read('orders', 'select rowid as CensusRowID, FCT_MoveOrders.* from FCT_MoveOrders order by rowid'),
    read('species', 'select rowid as CensusRowID, FCT_Species.* from FCT_Species order by rowid'),
  ])
  return { colonies, bodies, fleets, ships, classes, components, definitions, damage, cargo, orders, species }
}

const indexed = (set, field) => {
  const byKey = new Map()
  const uncertain = []
  for (const row of set.rows) {
    if (!known(row[field])) uncertain.push(row)
    else {
      if (!byKey.has(row[field])) byKey.set(row[field], [])
      byKey.get(row[field]).push(row)
    }
  }
  return { byKey, uncertain }
}

const nextDouble = (value, upward) => {
  if (value === 0) return upward ? Number.MIN_VALUE : -Number.MIN_VALUE
  return doubleOf(bitsOf(value) + ((value > 0) === upward ? 1n : -1n))
}

// One target body's unknown coordinate has finitely many membership regions, cut by readable fleet coordinates ±1. Include boundary doubles and their neighbours for strict floating-point tolerance.
const coordinateRegions = (fleets, axis) => {
  const points = [0]
  for (const fleet of fleets) {
    if (typeof fleet[axis] !== 'number' || !Number.isFinite(fleet[axis])) continue
    points.push(fleet[axis])
    for (const boundary of [fleet[axis] - 1, fleet[axis] + 1]) points.push(boundary, nextDouble(boundary, false), nextDouble(boundary, true))
  }
  const sorted = [...new Set(points.filter(Number.isFinite))].sort((a, b) => a - b)
  return [...new Set([...sorted, ...sorted.slice(1).map((value, index) => sorted[index] / 2 + value / 2)])]
}

const prepare = (data) => {
  // Failed rosters still have a finite relevant support when the guarded cargo rows or ships were read. Represent only those possible referenced objects, not speculative copies of a database.
  const possibleRows = (name, field, references, extras) => {
    const keys = new Set(references.filter(identity))
    let candidate = 1
    for (let index = 0; index < extras; index++) {
      while (keys.has(candidate)) candidate++
      keys.add(candidate++)
    }
    data[name].rows = [...keys].map((key, index) => ({ [field]: key, CensusKey: `${name}:possible:${key}`, CensusRowID: index, GameID: 1, CensusPossible: true }))
    data[name].bounded = true
  }
  if (!data.ships.complete && data.cargo.complete) possibleRows('ships', 'ShipID', data.cargo.rows.map((row) => row.ShipID), data.cargo.rows.filter((row) => !known(row.ShipID)).length)
  if (!data.fleets.complete && (data.ships.complete || data.ships.bounded)) possibleRows('fleets', 'FleetID', data.ships.rows.map((row) => row.FleetID), data.ships.rows.filter((row) => !known(row.FleetID)).length)
  const fields = { colonies: 'PopulationID', bodies: 'SystemBodyID', fleets: 'FleetID', ships: 'ShipID', classes: 'ShipClassID', definitions: 'SDComponentID', species: 'SpeciesID' }
  const rosters = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, indexed(data[name], field)]))
  const domains = Object.fromEntries(Object.entries(rosters).map(([name, index]) => [name, [...index.byKey.keys(), 0]]))
  domains.classes = [...new Set([...domains.classes, ...data.ships.rows.map((row) => row.ShipClassID).filter(known), ...data.components.rows.map((row) => row.ClassID).filter(known)])]
  domains.definitions = [...new Set([...domains.definitions, ...data.components.rows.map((row) => row.ComponentID).filter(known), ...data.damage.rows.map((row) => row.ComponentID).filter(known)])]
  const links = { ships: indexed(data.ships, 'FleetID'), components: indexed(data.components, 'ClassID'), damage: indexed(data.damage, 'ShipID'), cargo: indexed(data.cargo, 'ShipID'), orders: indexed(data.orders, 'FleetID') }
  const bodyKeys = [...new Set([...rosters.bodies.byKey.keys(), ...data.colonies.rows.map((row) => row.SystemBodyID).filter(known)])]
  const newBodies = Array.from({ length: data.colonies.rows.filter((row) => !known(row.SystemBodyID)).length + 1 }, (_, index) => `unread body ${index}`)
  return { rosters, domains, links, bodyKeys: [...bodyKeys, ...newBodies], coordinates: { Xcor: coordinateRegions(data.fleets.rows, 'Xcor'), Ycor: coordinateRegions(data.fleets.rows, 'Ycor') } }
}

// Find only fleets that can share a numeric cell in this relationship alternative. Unresolved links retain every destination; choices already made must not reconnect a row to a different destination.
const possibleFleetVariables = (data, indexes, choices) => {
  const byVariable = new Map()
  const selected = (row, field) => known(row[field]) ? row[field] : choices.get(`${row.CensusKey}.${field}`)
  const related = (name, key, field) => [...(indexes.links[name].byKey.get(key) || []), ...indexes.links[name].uncertain.filter((row) => selected(row, field) === undefined || selected(row, field) === key)]
  for (const fleet of data.fleets.rows) {
    const add = (key) => {
      if (!byVariable.has(key)) byVariable.set(key, new Set())
      byVariable.get(key).add(fleet.CensusKey)
    }
    for (const ship of related('ships', fleet.FleetID, 'FleetID')) {
      const classID = selected(ship, 'ShipClassID')
      const classes = classID === undefined ? indexes.domains.classes : [classID]
      for (const key of classes) {
        const shipClass = (indexes.rosters.classes.byKey.get(key) || [])[0] || { CensusKey: `classes:unread:${key}` }
        const ark = selected(shipClass, 'ArkShip')
        if (ark !== undefined && ark !== 1) continue
        if (!data.cargo.complete) add(`${ship.CensusKey}.unreadCargo`)
        for (const row of related('cargo', ship.ShipID, 'ShipID')) if (!known(row.Amount) && (selected(row, 'CargoTypeID') === undefined || selected(row, 'CargoTypeID') === 1)) add(`${row.CensusKey}.Amount`)
        if (!data.components.complete) add(`${ship.CensusKey}.unreadCapacity`)
        for (const row of related('components', key, 'ClassID')) {
          const componentID = selected(row, 'ComponentID')
          for (const id of componentID === undefined ? indexes.domains.definitions : [componentID]) {
            const definition = (indexes.rosters.definitions.byKey.get(id) || [])[0] || { CensusKey: `definitions:unread:${id}` }
            const type = selected(definition, 'ComponentTypeID')
            const fn = selected(definition, 'SpecialFunction')
            if ((type !== undefined && type !== 17) || (fn !== undefined && fn !== 7)) continue
            if (!known(row.NumComponent)) add(`${row.CensusKey}.NumComponent`)
            if (!known(definition.ComponentValue)) add(`${definition.CensusKey}.ComponentValue`)
            if (!data.damage.complete) add(`${ship.CensusKey}.activity:${id}`)
            for (const damage of related('damage', ship.ShipID, 'ShipID')) if (!known(damage.Number) && (selected(damage, 'ComponentID') === undefined || selected(damage, 'ComponentID') === id)) add(`${damage.CensusKey}.activity`)
          }
        }
      }
    }
  }
  return byVariable
}

const buildOrbital = (data, indexes, colony, RaceID, choices, model, fleetKeys = null) => {
  if (known(colony.RaceID) && !identity(colony.RaceID)) invalid('the colony race identity')
  const choose = (key, options, label) => {
    if (!choices.has(key)) throw new Alternative(key, options, label)
    return choices.get(key)
  }
  const unknown = (row, field, options, label) => known(row[field]) ? row[field] : choose(`${row.CensusKey}.${field}`, options, label)
  const reference = (row, field, options, label) => {
    if (known(row[field]) && (!Number.isInteger(row[field]) || row[field] < 0 || row[field] > Number(INT))) invalid(label)
    return unknown(row, field, options, label)
  }
  const scope = (row) => known(row.GameID) || choose(`${row.CensusKey}.scope`, [false, true], 'the game of an orbital row')
  const lookup = (name, key, guarded = false) => {
    const rows = indexes.rosters[name].byKey.get(key) || []
    if (rows.length > 1 || indexes.rosters[name].uncertain.length) invalid(`${name} identities`)
    if (rows.length) return scope(rows[0]) ? rows[0] : null
    if (guarded && data[name].complete) return null
    return { CensusKey: `${name}:unread:${key}`, GameID: 1 }
  }
  const related = (name, key, field, targetRoster) => {
    const index = indexes.links[name]
    const options = indexes.domains[targetRoster]
    const label = { ships: 'the fleet carrying the ship', cargo: 'the ship carrying the cargo', components: 'the class fitted with the berth component', damage: 'the ship with damaged components', orders: 'the fleet with move orders' }[name]
    return [...(index.byKey.get(key) || []), ...index.uncertain.filter((row) => reference(row, field, options, label) === key)].filter(scope).sort((a, b) => a.CensusRowID - b.CensusRowID)
  }
  const bodyOf = (row) => reference(row, 'SystemBodyID', indexes.bodyKeys, 'the colony body')
  const targetBody = bodyOf(colony)
  const body = lookup('bodies', targetBody) || { CensusKey: `bodies:unread:${targetBody}` }
  const bodyCoordinate = (axis) => {
    const value = unknown(body, axis, indexes.coordinates[axis], 'the colony body position')
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid('the colony body position')
    return value
  }
  const axisMatch = (fleet, axis) => {
    if (known(fleet[axis]) && (typeof fleet[axis] !== 'number' || !Number.isFinite(fleet[axis]))) invalid('the fleet position')
    if (!known(fleet[axis])) return choose(`${fleet.CensusKey}.${axis}.matches`, [false, true], 'the fleet position')
    return Math.abs(fleet[axis] - bodyCoordinate(axis)) < 1
  }
  const bodyMatches = (fleet) => {
    for (const axis of ['Xcor', 'Ycor']) if (Number.isFinite(fleet[axis]) && Number.isFinite(body[axis]) && Math.abs(fleet[axis] - body[axis]) >= 1) return false
    return axisMatch(fleet, 'Xcor') && axisMatch(fleet, 'Ycor')
  }
  const assignedHere = (fleet) => {
    const assigned = reference(fleet, 'AssignedPopulationID', [...indexes.rosters.colonies.byKey.keys(), 0], 'the fleet colony assignment')
    if (assigned === colony.PopulationID) return true
    const held = (indexes.rosters.colonies.byKey.get(assigned) || [])[0]
    if (held && bodyOf(held) === targetBody) return false
    const candidates = data.colonies.rows.filter((other) => {
      if (other === colony) return true
      if (known(other.RaceID) && other.RaceID !== RaceID) return false
      if (bodyOf(other) !== targetBody) return false
      return unknown(other, 'RaceID', [RaceID, 0], 'the race of another colony') === RaceID
    })
    return candidates.length === 1 || choose(`${fleet.CensusKey}.newAssignee:${targetBody}`, candidates.map((row) => row.PopulationID), 'which colony receives the unassigned fleet') === colony.PopulationID
  }
  const loadedCargo = (ship) => {
    if (!data.cargo.complete) return model.variable(`${ship.CensusKey}.unreadCargo`, 'integer', 'the colonist cargo rows')
    const terms = []
    for (const row of related('cargo', ship.ShipID, 'ShipID', 'ships')) {
      if (known(row.CargoTypeID) && row.CargoTypeID !== 1) continue
      if (row.Amount === 0) continue
      const species = reference(row, 'SpeciesID', [...indexes.rosters.species.byKey.keys(), 0], 'the cargo species')
      if (!lookup('species', species, true)) continue
      if (!data.species.complete && !indexes.rosters.species.byKey.has(species) && !choose(`species:${species}.exists`, [false, true], 'the cargo species roster')) continue
      if (unknown(row, 'CargoTypeID', [0, 1], 'the cargo category') !== 1) continue
      terms.push(model.quantity(row, 'Amount', 'integer', 'the colonist cargo amount'))
    }
    const total = sum(terms)
    model.atMost(total, CI)
    return terms.length ? minimum(total, CI) : C0
  }
  const capacity = (ship, classID, cargo) => {
    if (!data.components.complete) return minimum(cargo, model.variable(`${ship.CensusKey}.unreadCapacity`, 'decimal', 'the standard berth components'))
    const terms = []
    const seen = new Set()
    for (const row of related('components', classID, 'ClassID', 'classes')) {
      const componentID = reference(row, 'ComponentID', indexes.domains.definitions, 'the berth component definition')
      if (seen.has(componentID)) invalid('duplicate class component')
      seen.add(componentID)
      const definition = lookup('definitions', componentID) || { CensusKey: `definitions:unread:${componentID}` }
      if (known(definition.ComponentTypeID) && definition.ComponentTypeID !== 17) continue
      if (known(definition.SpecialFunction) && definition.SpecialFunction !== 7) continue
      if (unknown(definition, 'ComponentTypeID', [0, 17], 'the component category') !== 17 || unknown(definition, 'SpecialFunction', [0, 7], 'the component function') !== 7) continue
      const value = known(definition.ComponentValue) ? model.quantity(definition, 'ComponentValue', 'decimal', 'the standard berth capacity') : null
      const count = model.quantity(row, 'NumComponent', 'count', 'the standard berth component count')
      let damage = C0
      let activity = null
      if (!data.damage.complete) {
        activity = model.variable(`${ship.CensusKey}.activity:${componentID}`, 'integer', 'the undamaged berth component count')
      } else {
        const first = related('damage', ship.ShipID, 'ShipID', 'ships').find((damaged) => {
          const key = reference(damaged, 'ComponentID', indexes.domains.definitions, 'the damaged component link')
          return key === componentID && lookup('definitions', key, true)
        })
        if (first) {
          if (!known(first.Number)) activity = model.variable(`${first.CensusKey}.activity`, 'integer', 'the undamaged berth component count')
          else damage = model.quantity(first, 'Number', 'integer', 'the damaged berth component count')
        }
      }
      model.atMost(activity || damage, count)
      if (activity && count.op === 'constant') activity.hi = activity.hi < count.value.m ? activity.hi : count.value.m
      if (count.op === 'variable' && damage.op === 'constant') count.lo = count.lo > damage.value.m ? count.lo : damage.value.m
      const undamaged = activity || minus(count, damage)
      if (!activity && count.op === 'constant' && damage.op === 'constant' && decimal.equal(count.value, damage.value)) continue
      terms.push(times(undamaged, value || model.quantity(definition, 'ComponentValue', 'decimal', 'the standard berth capacity')))
    }
    return sum(terms)
  }
  if (!data.fleets.complete && !data.fleets.bounded) {
    const value = model.variable('unread fleets', 'integer', 'the orbital fleet roster')
    value.hi = INT * INT
    return value
  }
  const fleets = []
  for (const fleet of data.fleets.rows) {
    if (fleetKeys && !fleetKeys.has(fleet.CensusKey)) continue
    if (!scope(fleet)) continue
    if (fleet.CensusPossible && !choose(`${fleet.CensusKey}.exists`, [false, true], 'the orbital fleet roster')) continue
    if (known(fleet.RaceID) && fleet.RaceID !== RaceID) continue
    if (known(fleet.CivilianFunction) && fleet.CivilianFunction !== 0) continue
    if (!identity(fleet.FleetID) || indexes.rosters.fleets.byKey.get(fleet.FleetID).length !== 1) invalid('the fleet identity')
    const orders = related('orders', fleet.FleetID, 'FleetID', 'fleets')
    if (orders.length) continue
    if (!data.orders.complete && choose(`${fleet.CensusKey}.ordered`, [false, true], 'the fleet move orders')) continue
    if (unknown(fleet, 'RaceID', [RaceID, 0], 'the fleet race') !== RaceID || unknown(fleet, 'CivilianFunction', [0, 1], 'the fleet civilian function') !== 0) continue
    if (!bodyMatches(fleet)) continue
    if (!assignedHere(fleet)) continue
    if (!data.ships.complete && !data.ships.bounded) {
      fleets.push(model.variable(`${fleet.CensusKey}.unreadShips`, 'integer', 'the ships of the fleet'))
      continue
    }
    const occupants = []
    for (const ship of related('ships', fleet.FleetID, 'FleetID', 'fleets')) {
      if (ship.CensusPossible && !choose(`${ship.CensusKey}.exists`, [false, true], 'the ship roster')) continue
      if (!identity(ship.ShipID) || indexes.rosters.ships.byKey.get(ship.ShipID).length !== 1) invalid('the ship identity')
      const classID = reference(ship, 'ShipClassID', indexes.domains.classes, 'the ship class')
      const shipClass = lookup('classes', classID) || { CensusKey: `classes:unread:${classID}` }
      if (unknown(shipClass, 'ArkShip', [0, 1], 'the Ark ship flag') !== 1) continue
      const cargo = loadedCargo(ship)
      occupants.push(minimum(cargo, capacity(ship, classID, cargo)))
    }
    const total = truncate(sum(occupants))
    model.atMost(total, CI)
    fleets.push(minimum(total, CI))
  }
  return sum(fleets)
}

const colonyIntervals = (data, indexes, colony, RaceID) => {
  const choices = new Map()
  const merge = (a, b) => {
    if (!b) return a
    const lo = a ? decimal.minimum(a.lo, b.lo) : b.lo
    const hi = a ? maximum(a.hi, b.hi) : b.hi
    const hiExact = decimal.equal(lo, hi) || (a && decimal.equal(a.hi, hi) && a.hiExact) || (decimal.equal(b.hi, hi) && b.hiExact)
    return { lo, hi, hiExact: Boolean(hiExact), missing: decimal.equal(lo, hi) ? [] : [...new Set([...(a ? a.missing : []), ...b.missing])] }
  }
  const visit = () => {
    const result = { orbitalPeople: null, totalPopulation: null, unsupportedOrbit: null, unsupportedTotal: null }
    const model = numericModel()
    try {
      const orbital = buildOrbital(data, indexes, colony, RaceID, choices, model)
      // Follow shared-cell constraints to a fixed point of fleet reachability, not a fixed point over numeric values. Independent fleets (even at the same other colony) never enter this result's model.
      const localMissing = new Set(model.missing)
      const local = model.variables.size ? extrema(orbital, model) : null
      if (model.variables.size) {
        const candidates = possibleFleetVariables(data, indexes, choices)
        const visited = new Set()
        while (true) {
          const fleetKeys = new Set()
          for (const key of model.variables.keys()) for (const fleet of candidates.get(key) || []) if (!visited.has(fleet)) fleetKeys.add(fleet)
          if (!fleetKeys.size) break
          for (const fleet of fleetKeys) visited.add(fleet)
          for (const other of data.colonies.rows) {
            if (other === colony || (known(other.RaceID) && other.RaceID !== RaceID)) continue
            if (!known(other.RaceID)) {
              const key = `${other.CensusKey}.RaceID`
              if (!choices.has(key)) throw new Alternative(key, [RaceID, 0], 'the race of another colony')
              if (choices.get(key) !== RaceID) continue
            }
            buildOrbital(data, indexes, other, RaceID, choices, model, fleetKeys)
          }
        }
      }
      const counted = extrema(orbital, model)
      if (!counted) return result
      // A shared fleet that supplies no tighter bound adds no explanatory blocker.
      if (local && decimal.equal(local.lo, counted.lo) && decimal.equal(local.hi, counted.hi) && local.hiExact === counted.hiExact) {
        model.missing.clear()
        for (const label of localMissing) model.missing.add(label)
        counted.missing = decimal.equal(counted.lo, counted.hi) ? [] : [...localMissing]
      }
      result.orbitalPeople = counted
      try {
        const surface = model.quantity(colony, 'Population', 'decimal', 'surface population')
        const total = extrema(plus(surface, arithmetic('divide', orbital, constant(MILLION))), model)
        if (!total) result.unsupportedTotal = 'unsupported total population'
        result.totalPopulation = total
      } catch (error) {
        if (!(error instanceof Unsupported)) throw error
        result.unsupportedTotal = error.message
      }
    } catch (error) {
      if (error instanceof Alternative) {
        const alternatives = []
        for (const option of error.options) { choices.set(error.key, option); alternatives.push(visit()) }
        choices.delete(error.key)
        // Reachability is not influence. Compare supported results for this cell's alternatives, separately for each requested interval; an external constraint tightening a bound does not make every visited cell a blocker.
        for (const field of ['orbitalPeople', 'totalPopulation']) {
          const supported = alternatives.map((alternative) => alternative[field]).filter(Boolean)
          const first = supported[0]
          const influential = supported.some((interval) => !decimal.equal(interval.lo, first.lo) || !decimal.equal(interval.hi, first.hi))
          const merged = supported.reduce(merge, null)
          if (merged && !decimal.equal(merged.lo, merged.hi)) {
            if (influential) merged.missing = [...new Set([...merged.missing, error.label])]
          }
          result[field] = merged
        }
        result.unsupportedOrbit = alternatives.find((alternative) => alternative.unsupportedOrbit)?.unsupportedOrbit || null
        result.unsupportedTotal = alternatives.find((alternative) => alternative.unsupportedTotal)?.unsupportedTotal || null
      } else if (error instanceof Unsupported) result.unsupportedOrbit = error.message
      else throw error
    }
    return result
  }
  const intervals = visit()
  const { orbitalPeople, totalPopulation } = intervals
  let { unsupportedOrbit, unsupportedTotal } = intervals
  // A rejected categorical completion cannot erase a supported alternative. Only an empty supported union is unavailable.
  if (!orbitalPeople) unsupportedOrbit = unsupportedOrbit || 'unsupported orbital quantities'
  else unsupportedOrbit = null
  if (!totalPopulation) unsupportedTotal = unsupportedTotal || 'unsupported total population'
  else unsupportedTotal = null
  const publicInterval = (interval) => {
    if (!interval) return null
    const missing = interval.hiExact || decimal.equal(interval.lo, interval.hi) ? interval.missing : [...new Set([...interval.missing, 'the unknown quantities cannot yet be settled together within their supported ranges'])]
    return { lo: interval.lo, hi: interval.hi, missing }
  }
  return { orbitalPeople: publicInterval(orbitalPeople), totalPopulation: publicInterval(totalPopulation), unsupported: unsupportedOrbit || unsupportedTotal }
}

const predicate = (interval, million) => {
  const value = !interval ? null : million ? (decimal.compare(interval.lo, ONE) >= 0 ? true : decimal.compare(interval.hi, ONE) < 0 ? false : null) : (decimal.positive(interval.lo) ? true : interval.hi.m === 0n ? false : null)
  return value === null ? unavailable({ rule: RULE, missing: interval ? interval.missing : ['unsupported population inputs'] }) : ofRule({ rule: RULE, value, inputs: { present: ['surface and orbital population bounds'] } })
}

export const loadOrbitalCensus = async (database, { GameID, RaceID }) => {
  if (!identity(GameID) || !identity(RaceID)) throw new RangeError('unsupported census selection')
  const data = await acquire(database, GameID)
  const seen = new Set()
  for (const colony of data.colonies.rows) {
    if (!identity(colony.PopulationID) || seen.has(colony.PopulationID)) throw new RangeError('unsupported colony identity')
    seen.add(colony.PopulationID)
  }
  const indexes = prepare(data)
  const result = new Map()
  for (const colony of data.colonies.rows) {
    if (identity(colony.RaceID) && colony.RaceID !== RaceID) continue
    const intervals = colonyIntervals(data, indexes, colony, RaceID)
    const { orbitalPeople, totalPopulation } = intervals
    const failed = (million) => totalPopulation ? predicate(totalPopulation, million) : unavailable({ rule: RULE, missing: [intervals.unsupported || 'unsupported population inputs'] })
    result.set(colony.PopulationID, { raceMatches: identity(colony.RaceID) ? true : null, orbitalPeople, totalPopulation, hasPopulation: failed(false), millionEligible: failed(true) })
  }
  return result
}
