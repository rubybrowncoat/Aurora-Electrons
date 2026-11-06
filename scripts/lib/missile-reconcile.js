/*
  The reconciliation of a saved missile design with the figures the save stored with it: every figure the rules rebuild, set against its stored figure, judged as agreeing, differing (explained or a mismatch), unsupported or unknown. It is the report layer of scripts/check-design-rules.js and not a rule: the rules (missileAccounting, the engine design, the level resolution) live in utilities/design-rules.js and utilities/design-data.js and are given in `{ rules, data }`, so a planted fault in either is a fault of what this reconciles.

  It is an ES module with no imports, like the utilities, so the check script loads it through scripts/lib/utilities.js (`loadUtilities(['missile-reconcile'], { directory: scripts/lib })`) and a mutant check loads a mutated copy of the folder the same way.

  A fixture is what the save held for a set of designs, as plain data (utilities/design-data.js `loadMissileFixture`): { levels: { id: { type, info, cost } }, races: { id: { name, held: { type: [level ids] } } }, components: { id: { id, name, size, cost, power, fuelEfficiency, tech1, tech2 } }, designs: [{ id, race, row }] } with `row` the FCT_MissileType columns the rules read.
*/

const isKnown = (value) => value !== null && value !== undefined && !Number.isNaN(value)

// A figure as a report shows it: to 10 significant digits, so a sum of decimals does not print its rounding.
const figure = (value) => (typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(10)) : value)

// What a comparison rests on: `reproduced` (the figure is rebuilt from inputs the design stores and compared with another stored figure) or `resolved-from-stored` (the technology level behind it was itself picked by matching the stored figure being compared, so agreement says that some held level gives it, not that the rule gives it independently).
export const BASIS = Object.freeze({ REPRODUCED: 'reproduced', RESOLVED: 'resolved-from-stored' })

// The stored column each line's level is picked to match, for the unknown-provenance comparison of a line no held level resolves.
export const LEVEL_STORED = Object.freeze({ warhead: 'WarheadStrength', shipDecoy: 'ShipDecoy', laserEfficiency: 'LaserWarhead', terminal: 'ATG', retarget: 'Retargeting', eccm: 'ECCM', multipleWarheads: 'MultipleWarheads', emSensitivity: 'EMSensitivity', laserFocus: 'LaserWarheadRangeModifier', missileEcm: 'MissileECM', active: 'SensorStrength', thermal: 'ThermalStrength', em: 'EMStrength', geo: 'Geostrength', reactor: 'MSPReactor' })

// The reconciliation of the missile designs a save stores with the rules and loaders it is given.
export const createMissileReconciler = ({ rules, data }) => {
  const { agrees, roundHalfEven, CONTRIBUTIONS, MIN_SENSOR_MSP, MISSILE_STORED_MINERALS, missileAccounting, missileEngineDesign, missileSensorRange, thrustOfMissileEngine } = rules
  const { LINE_STATE, MISSILE_TECH, heldMissileLevels, matchLevels, missileEngineOf, missileLevelRecord, missileLevelsOfType, missileStageOf, resolveMissileLevels, savedMissileCandidate, storedMineralTotal } = data
  // Whether the scope found a pin's audited figure: both figures must be there (a stored NULL is not the audited 0) and agree at the reproduction tolerance.
  const pinned = (audited, found) => isKnown(audited) && isKnown(found) && agrees(audited, found)

  // What a comparison says: 'unsupported' when it names a case the rules do not cover (never agreement), 'unknown' when the stored or the computed figure is missing (never zero), else 'agree' or 'differ' at the reproduction tolerance (an 'integer' figure exactly).
  const judge = (comparison) => {
    if (comparison.unsupported) {
      return 'unsupported'
    }

    if (!isKnown(comparison.stored) || !isKnown(comparison.computed)) {
      return 'unknown'
    }

    const same = comparison.kind === 'integer' ? Number(comparison.stored) === Number(comparison.computed) : agrees(Number(comparison.stored), Number(comparison.computed))

    return same ? 'agree' : 'differ'
  }

  // A pinned difference is a hand-audited discrepancy of one design of one game of one save: `{ save, game, id, field, stored, computed, reason }`. It explains a difference only while the design's stored and computed figures are the audited ones at the reproduction tolerance, so a changed figure, or another save that reuses the id, is not covered.
  const pinFor = (known, game, id, entry) => known.find((candidate) => candidate.game === game && candidate.id === id && candidate.field === entry.field && pinned(candidate.stored, entry.stored) && pinned(candidate.computed, entry.computed)) || null

  const knownDifference = (known, game, id, entry) => {
    const row = pinFor(known, game, id, entry)

    return row ? row.reason : null
  }

  // Why a pin no comparison of the scope used: that the scope is another game than the pin's, what the scope saw of its row and field, or that it saw none (the row is not in the scope read, or the game has none).
  const pinState = (pin, sight, game, absent) => {
    if (pin.game !== game) {
      return `the pin is of game ${pin.game} and the scope read is of game ${game}`
    }

    if (!sight) {
      return absent ? 'the game has no such row' : 'the save has no such row in the scope read'
    }

    if (sight.verdict === 'agree') {
      return `the stored ${figure(sight.stored)} now agrees with the computed ${figure(sight.computed)}`
    }

    if (sight.verdict !== 'differ') {
      return `the figure is ${sight.verdict} now`
    }

    const changed = [...(pinned(pin.stored, sight.stored) ? [] : [`stored ${figure(sight.stored)}, pinned ${figure(pin.stored)}`]), ...(pinned(pin.computed, sight.computed) ? [] : [`computed ${figure(sight.computed)}, pinned ${figure(pin.computed)}`])]

    return `a figure changed: ${changed.join('; ')}`
  }

  // The pins of one pinned save (`save`, a key of scripts/lib/pinned-saves.js, or null for a save no pin belongs to) and the account of what the comparisons of a scope made of them. `see` takes every comparison of the scope, whatever its verdict, and gives the pin that explains a difference (marking it used); `read` takes a row the scope read but could not compare, whose pinned fields are then unknown. `stale` is each pin of the save that no comparison used: where the scope is `complete` (every row of the game was read) that includes a pin of a row the save no longer has; where it is not, a pin of a row that was read, and a pin of a row `present` (the ids of the rows the game holds, or null where that is not read) lacks. `unread` counts the pins of the rest: rows of the game that this scope did not read.
  const createPinLedger = (known, { save, game, complete, present = null }) => {
    const mine = known.filter((pin) => pin.save === save)
    const keys = new Set(mine.map((pin) => `${pin.id}|${pin.field}`))
    const used = new Set()
    const seen = new Map()
    const keyOf = (pin) => `${pin.id}|${pin.field}`
    const isStale = (pin) => !used.has(pin) && (complete || seen.has(keyOf(pin)) || (present !== null && !present.has(pin.id)))

    return Object.freeze({
      pins: mine,
      see: (row, field, verdict, stored, computed) => {
        const key = `${row.id}|${field}`

        if (!keys.has(key)) {
          return null
        }

        seen.set(key, { name: row.name, verdict, stored, computed })

        const pin = verdict === 'differ' ? pinFor(mine, game, row.id, { field, stored, computed }) : null

        if (pin) {
          used.add(pin)
        }

        return pin
      },
      // A row the scope read but could not compare (skipped for a missing tech row, or another reason outside the rules): every pinned field of it is observed as unknown, so a pin of it is stale — the row was read and its figure could not be checked — and never one of a row this run does not read. The report calls it before it skips the row, since a skip ends the row's comparisons.
      read: (row) => {
        for (const key of keys) {
          if (key.startsWith(`${row.id}|`)) {
            seen.set(key, { name: row.name, verdict: 'unknown', stored: null, computed: null })
          }
        }
      },
      stale: () => mine.filter(isStale).map((pin) => ({ pin, name: seen.has(keyOf(pin)) ? seen.get(keyOf(pin)).name : '(not in the save)', why: pinState(pin, seen.get(keyOf(pin)), game, present !== null && !present.has(pin.id)) })),
      unread: () => mine.filter((pin) => !used.has(pin) && !isStale(pin)).length,
    })
  }

  // The verdict of a comparison and, for a difference, the reason it is explained by (its own or a pinned one); a difference with no reason is a mismatch.
  const classify = (known, game, id, entry) => {
    const verdict = judge(entry)

    if (verdict !== 'differ') {
      return { verdict, reason: null }
    }

    return { verdict, reason: entry.explain || knownDifference(known, game, id, entry) }
  }

  const comparison = (field, scope, stored, computed, kind = 'decimal', extra = {}) => ({ field, scope, stored: isKnown(stored) ? stored : null, computed: isKnown(computed) ? computed : null, kind, basis: BASIS.REPRODUCED, ...extra })

  // The missile engine component against the engine the rules design from its two techs and the thrust (the missile's PowerMod; for an engine no design in the set uses, the thrust its stored power implies). The greatest thrust modifier the design had is the held level whose boost reproduces the stored fuel efficiency; none that does leaves the fuel efficiency unknown. `race` is null when the owner is not known, and every max thrust level of the save is then a candidate.
  const reconcileEngine = (fixture, component, { thrust = null, race = null } = {}) => {
    const engineLevel = missileLevelRecord(fixture, component.tech1)
    const fuelLevel = missileLevelRecord(fixture, component.tech2)
    const engineTech = engineLevel ? engineLevel.info : null
    const fuelTech = fuelLevel ? fuelLevel.info : null
    const given = isKnown(thrust) && thrust > 0
    const used = given ? thrust : (isKnown(engineTech) && engineTech > 0 ? thrustOfMissileEngine({ power: component.power, sizeMsp: component.size, engineTech }) : null)
    const candidates = race === null ? missileLevelsOfType(fixture, MISSILE_TECH.maxThrust) : (heldMissileLevels(fixture, race)[MISSILE_TECH.maxThrust] || [])
    const designAt = (maxThrust) => (isKnown(used) && isKnown(engineTech) && isKnown(fuelTech) ? missileEngineDesign({ sizeMsp: component.size, thrust: used, engineTech, fuelTech, maxThrust }) : null)
    const { matches, level } = matchLevels(candidates, (info) => {
      const design = designAt(info)

      return design !== null && agrees(component.fuelEfficiency, design.fuelEfficiency)
    })
    const chosen = !given || matches.length < candidates.length ? BASIS.RESOLVED : BASIS.REPRODUCED
    const design = designAt(level ? level.info : candidates.length ? candidates[0].info : 1)
    const reasonNoTech = !engineLevel ? `the engine tech level ${component.tech1} is not in the save` : !fuelLevel ? `the fuel tech level ${component.tech2} is not in the save` : null
    const comparisons = []

    if (given) {
      comparisons.push(comparison('EnginePower', 'engine', component.power, design ? design.power : null, 'decimal', { reason: reasonNoTech }))
    }

    comparisons.push(comparison('EngineCost', 'engine', component.cost, design ? design.cost : null, 'decimal', { reason: reasonNoTech, basis: given ? BASIS.REPRODUCED : BASIS.RESOLVED }))
    comparisons.push(comparison('FuelEfficiency', 'engine', component.fuelEfficiency, level && design ? design.fuelEfficiency : null, 'decimal', { basis: chosen, reason: reasonNoTech || `no held max thrust level (type ${MISSILE_TECH.maxThrust}) reproduces the stored fuel efficiency at thrust ${isKnown(used) ? Number(used.toPrecision(6)) : 'unknown'}` }))

    return { id: component.id, name: component.name, thrust: used, maxThrust: level, maxThrustMatches: matches, comparisons }
  }

  // One design against its stored row: every figure the rules rebuild from the levels its race holds, each as a comparison { field, scope, stored, computed, kind, reason?, explain?, unsupported? } to pass through `judge`, plus what the rebuild is made of (`lines`: the levels, `ledger`: size, cost and minerals per contribution). `explain` is a reason to give when the comparison differs and the difference is understood; a comparison is never `explain`ed to agree.
  const reconcileMissile = (fixture, design) => {
    const row = design.row
    const { lines, tech } = resolveMissileLevels(row, heldMissileLevels(fixture, design.race))
    const engine = missileEngineOf(fixture, row)
    const stage = missileStageOf(fixture, row)
    const unwritten = row.MultipleWarheads > 1 && row.MSPMultipleWarheads === 0
    const candidateAt = (sizeLimit) => savedMissileCandidate(row, { engine, stage, tech, sizeLimit })
    const free = missileAccounting(candidateAt(0))
    const engineRounding = engine && !engine.missing ? roundHalfEven(engine.sizeMsp * row.NumEngines, 4) - engine.sizeMsp * row.NumEngines : 0
    const excess = isKnown(free.figures.sizeSum) ? free.figures.sizeSum - row.Size : null
    const capped = excess !== null && excess > 0 && !agrees(free.figures.sizeSum, row.Size) ? missileAccounting(candidateAt(row.Size)) : null
    const limited = capped !== null && Math.abs(excess - engineRounding) <= 1e-9 && isKnown(capped.figures.speed) && agrees(row.Speed, capped.figures.speed)
    const built = limited ? capped : free
    const figures = built.figures
    const ground = row.GroundShots > 0
    const warheadUnsupported = lines.warhead.state === LINE_STATE.UNSUPPORTED
    const reasons = [...new Set([...Object.values(lines).filter((entry) => entry.state === LINE_STATE.UNRESOLVED).map((entry) => entry.reason), ...CONTRIBUTIONS.map((name) => built.contributions[name].unknown).filter(Boolean)])]
    const reason = reasons.length ? reasons.join('; ') : null
    const unsupportedBy = lines.warhead.reason
    const comparisons = []
    const add = (field, scope, stored, computed, kind = 'decimal', { explain = null, warheadDependent = false, basis = BASIS.REPRODUCED } = {}) => comparisons.push(comparison(field, scope, stored, computed, kind, { reason, explain, basis, unsupported: ground || (warheadDependent && warheadUnsupported) ? unsupportedBy : null }))
    const basisOf = (name) => (lines[name].state === LINE_STATE.RESOLVED ? BASIS.RESOLVED : BASIS.REPRODUCED)
    const storedPlain = storedMineralTotal(row)
    const minerals = figures.minerals
    const dependent = { warheadDependent: true }
    const decoy = row.ShipDecoy === 1

    add('Size', 'size', row.Size, free.figures.size, 'decimal', limited ? { explain: `the stored contributions add up to ${Number(free.figures.sizeSum.toPrecision(10))} MSP, ${Number(excess.toPrecision(4))} over the stored size: exactly the engine's size rounded to 4 decimals in MSPEngine; the game allots the fuel as the remainder of the size the design was made to and caps the size there, and at the stored size the speed reproduces` } : {})
    add('MSPEngine', 'size', row.MSPEngine, engine && engine.missing ? null : built.contributions.engine.msp)

    if (engine && engine.missing) {
      add('EngineComponent', 'engine', row.EngineID, null, 'integer')
    }

    add('MSPReactor', 'size', row.MSPReactor, built.contributions.reactor.msp, 'decimal', { basis: basisOf('reactor') })
    add('MSPDecoys', 'size', row.MSPDecoys, built.contributions.decoys.msp)
    add('MSPMultipleWarheads', 'size', row.MSPMultipleWarheads, built.contributions.extraWarheads.msp, 'decimal', unwritten ? { explain: 'the design stores 0 for the size of the warheads after the first although its cost and Tritanium include 0.1 each, as game 137 of the 2.6 and 2.7.1 saves and game 139 of the 2.7.0 save store it; seen in the modded sample and in game 143 of the 2.7.0 save, where the designs sit at the size floor or at their size limit, which hides whether the size adds it' } : {})
    add('WarheadStrength', 'warhead', row.WarheadStrength, figures.warheadStrength, 'decimal', { warheadDependent: true, basis: basisOf('warhead') })
    add('RadDamage', 'warhead', row.RadDamage, decoy ? 0 : figures.warheadStrength, 'decimal', { warheadDependent: true, basis: basisOf('warhead') })
    add('LaserWarhead', 'warhead', row.LaserWarhead, figures.laserWarhead, 'decimal', { warheadDependent: true, basis: basisOf('laserEfficiency') })

    for (const [field, key] of [['SensorStrength', 'active'], ['ThermalStrength', 'thermal'], ['EMStrength', 'em'], ['Geostrength', 'geo']]) {
      add(field, 'sensor', row[field], figures.strengths[key], 'decimal', { basis: basisOf(key) })
    }

    add('SensorRange', 'sensor', row.SensorRange, row.MSPActive >= MIN_SENSOR_MSP ? missileSensorRange({ strength: figures.strengths.active, emSensitivity: row.EMSensitivity, resolution: row.SensorResolution }) : 0, 'integer')
    add('Cost', 'cost', row.Cost, figures.cost, 'decimal', dependent)

    for (const name of MISSILE_STORED_MINERALS) {
      add(name, 'cost', row[name], minerals[name], 'decimal', dependent)
    }

    add('UnstoredMinerals', 'cost', storedPlain === null ? null : row.Cost - storedPlain, isKnown(minerals.Corundium) && isKnown(minerals.Vendarite) ? minerals.Corundium + minerals.Vendarite : null, 'decimal', dependent)
    add('Speed', 'performance', row.Speed, figures.speed)
    add('Endurance', 'performance', row.Endurance, figures.endurance)
    add('MaxRange', 'performance', row.MaxRange, figures.maxRange)
    add('FuelRequired', 'performance', row.FuelRequired, figures.fuelRequired)
    add('TotalFlightTime', 'performance', row.TotalFlightTime, figures.totalFlightTime)

    for (const [name, entry] of Object.entries(lines)) {
      if (entry.state === LINE_STATE.UNRESOLVED) {
        comparisons.push(comparison(`Level:${name}`, 'level', row[LEVEL_STORED[name]], null, 'decimal', { reason: entry.reason }))
      }
    }

    return { id: design.id, name: row.Name, race: design.race, lines, limited, ledger: built.contributions, figures, comparisons }
  }

  return { judge, pinFor, knownDifference, classify, createPinLedger, comparison, BASIS, LEVEL_STORED, reconcileEngine, reconcileMissile }
}
