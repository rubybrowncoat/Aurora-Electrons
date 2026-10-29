/*
  Checks the planners' design rules (src/renderer/utilities/design-rules.js) against a save: every stored engine, class speed, class range input, jump drive and class maintenance figure (annual failure rate, maintenance supplies, damage roll and thresholds) of one race is recomputed from the rows it was designed with and compared with what the game wrote.

  node scripts/check-design-rules.js <save.db> --race <RaceID> [--rules engine,speed,range,jump,maintenance,missile,sensor] [--all-game] [--ledger]

  Zero mismatches means the rules reproduce every stored row. A row the rules cannot reproduce for a reason outside them (a modded tech, a missing tech row, a design made under older rules) is counted as explained, with its reason; any other difference is a mismatch and sets exit code 1. The race's components are the FCT_ShipDesignComponents rows of its game that it holds through FCT_RaceTech (TechID = SDComponentID), the way the Propulsion Planner selects them; --all-game checks every component of the game instead, other races' designs included. Each check is printed under the id, verification and game versions of the rules it checks, read from the rule registry (utilities/provenance.js, filled by design-rules.js), and a registered rule that no check run covers is listed at the end. The save is opened read-only through the same sqlite3 module the app uses.

  The missile check rebuilds every missile design (FCT_MissileType) from the engine component it names, the sizes it allots and the technology levels its race held when it was designed, and compares size in MSP, the cost in BP with each mineral, the speed, endurance, range and fuel with what the game stored, at 1e-9 relative. The levels are not stored with a design: each is the held level that reproduces the stored figure (utilities/design-data.js `resolveMissileLevels`; the rules are the design.missile* ones of utilities/design-rules.js, the comparison is scripts/lib/missile-reconcile.js). A figure the save lacks, or whose level the race does not hold, is counted as unknown and never as 0; a case the rules do not cover (a ground attack pod, an enhanced radiation warhead) is counted as unsupported and never as agreement; neither is a match. --all-game checks the missiles of every race with the techs of the race that researched each; --ledger prints the size, cost and levels of each contribution of each design.

  The sensor check rebuilds every active sensor, missile fire control, passive sensor and beam fire control the race owns from the techs its components name, each tech found by its tech type and never by the slot it sits in, and compares the strength, range, cost with its Uridium and Corbomite, crew, HTK, ECCM and CTD and, for a beam fire control, the size, range, tracking and special function with what the game stored (utilities/design-data.js `loadSensorFixture`; the rules are the design.*Sensor* and design.beamFireControl* ones of utilities/design-rules.js, the comparison is scripts/lib/sensor-reconcile.js). A figure whose tech the component does not name, names twice or names by a row the save lacks is counted as unknown and never as 0. A difference is explained only by an alternative of the reconciliation that fits (the techs the stored figures imply, a tenth of the cost, an uncapped range) or by a row of KNOWN_SENSOR_ROWS pinned to its stored and computed figures; any other is a mismatch.

  node scripts/check-design-rules.js --fixtures                  runs the missile and sensor reports on the fixtures in scripts/lib/missile-fixtures.json and scripts/lib/sensor-fixtures.json, the checks of the rules and of the candidate evaluator (utilities/design-rules.js `evaluateMissile`) on them, and every planted fault of the rules, the loaders and the reconciliations (each must fail the checks it names); no save is read
  node scripts/check-design-rules.js <save.db> --race <RaceID> [--all-game] --export-missile-fixture <file.json> --label <name> [--note <text>]   writes the designs of the scope into the fixtures file
  node scripts/check-design-rules.js <save.db> --race <RaceID> [--all-game] --export-sensor-fixture <file.json> --label <name> [--note <text>]    writes the sensors and fire controls of the scope into the fixtures file
  node scripts/check-design-rules.js --run-mutant <name>        one planted fault of the rules in this process, its result printed as JSON: what --fixtures starts for each fault, so no fault shares module state with another or with the checks
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { inParallel, jobs, runChild } = require('./lib/check-pool')

const RULES = ['engine', 'speed', 'range', 'jump', 'maintenance', 'missile', 'sensor']

// The registered rules whose formulas each check compares with stored values. The range check compares only the stored fuel efficiency with the class's engines, an input of the burn and range formulas, so it names no rule: design.burnPerHour and design.fullPowerRangeKm stay in the list of rules no check covers.
const RULE_IDS = { engine: ['design.engineDesign'], speed: ['design.classSpeed'], range: [], jump: ['design.jumpDriveDesign'], maintenance: ['design.engineeringMsp', 'design.maintenanceStorage', 'design.classMaintenanceSupplies', 'design.annualFailureRate', 'design.damageAllocation'], missile: ['design.missileEngineDesign', 'design.missileAccounting', 'design.missileLevels'], sensor: ['design.activeSensorDesign', 'design.passiveSensorDesign', 'design.beamFireControlDesign', 'design.beamFireControlLimits', 'design.sensorDetection', 'design.sensorInverseSizing'] }
const INPUT_ONLY = { range: 'input check only: the stored fuel efficiency against the class\'s engines; the burn and range formulas are not compared with a stored value' }
const MISSILE_LIBRARY = path.resolve(__dirname, 'lib')
const MISSILE_FIXTURES = path.join(MISSILE_LIBRARY, 'missile-fixtures.json')
const SENSOR_FIXTURES = path.join(MISSILE_LIBRARY, 'sensor-fixtures.json')
const UTILITIES = path.resolve(__dirname, '..', 'src', 'renderer', 'utilities')
const RELATIVE_TOLERANCE = 1e-6
const ABSOLUTE_TOLERANCE = 1e-9
const NAMED_CLASSES = [64475, 62944]

// Rows the rules cannot reproduce for a reason outside them, each checked by hand against the saves. A key is rule:id:field. Nothing else is explained away: a difference not listed here and not matched by a pattern in engineExplainer or jumpExplainer is a mismatch.
const KNOWN_ROWS = {
  'engine:500260:cost': "the stored cost is a tenth of the rule's 1500; the sample's other engines on the same thermal tech (500722, 500735, 500606) match the rule, so this cost was changed outside the design rule",
  'engine:500613:military': "a 0.8 HS engine at thrust 0.9 is military under the rule (commercial needs 25 HS and thrust 0.5 or less); the flag was changed outside the design rule, and the sample's commercial engines (500246, 500707, 500708) obey it",
}

// Missile differences checked by hand, each pinned to its game, design, field and the stored and computed figures observed (the library's `knownDifference` explains a difference only while both still match): a changed figure, or another save that reuses the id, is a mismatch.
const KNOWN_MISSILE_ROWS = [
  { game: 140, id: 500724, field: 'Cost', stored: 211.85, computed: 349.05, reason: "the stored cost equals the sum of the stored minerals and is 137.2 BP under the rule's: the design carries a thermal sensor of strength 150 on the modded thermal level 10000, far above the stock levels, and its stored Uridium (15.1) is 136.3 under the rule's; the cause is not identified" },
  { game: 140, id: 500724, field: 'Uridium', stored: 15.1, computed: 151.4, reason: "the rule's Uridium is the thermal sensor's 150 plus 0.9 of terminal guidance and 0.5 of retargeting; the stored 15.1 is 136.3 BP less, nearly all of the difference in the stored cost, and the cause is not identified" },
  { game: 140, id: 500724, field: 'UnstoredMinerals', stored: 0, computed: 0.9, reason: 'the stored cost equals the stored minerals, so the 0.9 Corundium the rule adds for the laser warhead is not in the cost of this design (the laser designs of the other races in the sample do match the rule); the cause is not identified, and it may be the same one as in the Uridium' },
  { game: 138, id: 154678, field: 'Endurance', stored: 5643561.9, computed: 5647991.8, reason: "the stored endurance is 0.08% under the rule's, from a 625 L own tank at 0.23 EP and fuel use 1.73205 L/EPH (engine 154677, thrust 0.5, nine second stages); the speed (460), the fuel (850 L with the stages') and every other figure of the design reproduce, so the cause is not identified: the engine's unrounded power (0.234375 EP) would move the endurance 1.9%, not 0.08%" },
  { game: 138, id: 154678, field: 'MaxRange', stored: 2596038501, computed: 2598076228, reason: 'follows the endurance of this design, 154678, the difference of which is not identified' },
  { game: 138, id: 154678, field: 'TotalFlightTime', stored: 6306886, computed: 6311316.8, reason: "follows the endurance of this design, 154678: the second stages' flight time adds to it unchanged" },
]

const fail = (message) => {
  console.error(message)
  process.exit(2)
}

const parseArguments = (argv) => {
  const options = { save: null, race: null, rules: RULES, allGame: false, ledger: false, fixtures: false, mutant: null, exportFile: null, sensorExportFile: null, label: null, note: '' }

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]

    if (argument === '--race') {
      options.race = Number(argv[++index])
    } else if (argument === '--rules') {
      options.rules = String(argv[++index]).split(',').map((rule) => rule.trim()).filter(Boolean)
    } else if (argument === '--all-game') {
      options.allGame = true
    } else if (argument === '--ledger') {
      options.ledger = true
    } else if (argument === '--fixtures') {
      options.fixtures = true
    } else if (argument === '--export-missile-fixture') {
      options.exportFile = String(argv[++index])
    } else if (argument === '--export-sensor-fixture') {
      options.sensorExportFile = String(argv[++index])
    } else if (argument === '--label') {
      options.label = String(argv[++index])
    } else if (argument === '--note') {
      options.note = String(argv[++index])
    } else if (argument === '--run-mutant') {
      options.mutant = String(argv[++index])
    } else if (argument.startsWith('--')) {
      fail(`Unknown option ${argument}`)
    } else {
      options.save = argument
    }
  }

  if (!options.fixtures && options.mutant === null && (!options.save || !Number.isInteger(options.race))) {
    fail('Usage: node scripts/check-design-rules.js <save.db> --race <RaceID> [--rules engine,speed,range,jump,maintenance,missile,sensor] [--all-game] [--ledger]\n       node scripts/check-design-rules.js <save.db> --race <RaceID> [--all-game] --export-missile-fixture <file.json> --label <name> [--note <text>]\n       node scripts/check-design-rules.js <save.db> --race <RaceID> [--all-game] --export-sensor-fixture <file.json> --label <name> [--note <text>]\n       node scripts/check-design-rules.js --fixtures')
  }

  if ((options.exportFile || options.sensorExportFile) && !options.label) {
    fail('--export-missile-fixture and --export-sensor-fixture need --label')
  }

  const unknown = options.rules.filter((rule) => !RULES.includes(rule))

  if (unknown.length) {
    fail(`Unknown rule ${unknown.join(', ')}; choose from ${RULES.join(', ')}`)
  }

  return options
}

const open = (file) => new Promise((resolve, reject) => {
  if (!fs.existsSync(file)) {
    reject(new Error(`No such save: ${file}`))
    return
  }

  const database = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(database)))
})

const all = (database, sql, parameters = []) => new Promise((resolve, reject) => {
  database.all(sql, parameters, (error, rows) => (error ? reject(error) : resolve(rows)))
})

const loadRules = async () => {
  const { 'design-rules': rules, provenance: registry } = await loadUtilities(['design-rules', 'provenance'])

  return { ...rules, registry, isAvailable: registry.isAvailable }
}

const close = (stored, computed) => Math.abs(stored - computed) <= Math.max(ABSOLUTE_TOLERANCE, RELATIVE_TOLERANCE * Math.max(Math.abs(stored), Math.abs(computed)))

const format = (value) => (typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(10)) : value)

class Report {
  constructor (rule, ruleIds, scope = '') {
    this.rule = rule
    this.ruleIds = ruleIds
    this.scope = scope
    this.checked = 0
    this.mismatches = []
    this.explained = []
    this.notes = []
  }

  // `kind` is 'integer' (exact), 'decimal' (relative tolerance) or 'flag'. The difference is explained when `explain(field, stored, computed)` gives a reason or the row is in KNOWN_ROWS, otherwise it is a mismatch.
  compare (row, field, stored, computed, kind, explain) {
    const same = kind === 'decimal' ? this.close(Number(stored), Number(computed)) : Number(stored) === Number(computed)

    if (same) {
      return
    }

    const entry = { id: row.id, name: row.name, field, stored: format(stored), computed: format(computed) }
    const reason = KNOWN_ROWS[`${this.rule}:${row.id}:${field}`] || (explain ? explain(field, Number(stored), Number(computed)) : null)

    if (reason) {
      this.explained.push({ ...entry, reason })
    } else {
      this.mismatches.push(entry)
    }
  }

  // A row that cannot be recomputed at all.
  skip (row, reason) {
    this.explained.push({ id: row.id, name: row.name, field: '-', stored: '-', computed: '-', reason })
  }

  // The check's registered rules, each with its verification and game versions, so the output says what the zero mismatches are evidence for; a check that compares no rule's formula says so.
  describeRules (registry) {
    if (!this.ruleIds.length) {
      return this.scope
    }

    return this.ruleIds.map((id) => {
      const rule = registry.getRule(id)

      if (!rule) {
        throw new Error(`Rule ${id} is not registered in design-rules.js`)
      }

      return `${id}: ${rule.verification}, game ${rule.versions.join(', ')}`
    }).join('; ')
  }

  // The tolerance two decimal figures agree to; a report that holds its figures closer overrides it.
  close (stored, computed) {
    return close(stored, computed)
  }

  // What a report adds to its counts, and what it prints after its differences; none for a report that has no more to say.
  tally () {
    return ''
  }

  printMore () {}

  print (registry) {
    console.log(`${this.rule} [${this.describeRules(registry)}]: ${this.checked} checked, ${this.mismatches.length} mismatches, ${this.explained.length} explained${this.tally()}`)

    for (const note of this.notes) {
      console.log(`  note: ${note}`)
    }

    for (const entry of this.mismatches) {
      console.log(`  MISMATCH ${entry.id} "${entry.name}" ${entry.field}: stored ${entry.stored}, computed ${entry.computed}`)
    }

    for (const entry of this.explained) {
      console.log(`  explained ${entry.id} "${entry.name}" ${entry.field}: stored ${entry.stored}, computed ${entry.computed} - ${entry.reason}`)
    }

    this.printMore()
  }
}

const componentsSql = (allGame, typeId) => `select FCT_ShipDesignComponents.* from FCT_ShipDesignComponents${allGame ? '' : ' inner join FCT_RaceTech on FCT_RaceTech.TechID = FCT_ShipDesignComponents.SDComponentID and FCT_RaceTech.GameID = FCT_ShipDesignComponents.GameID and FCT_RaceTech.RaceID = :race'} where FCT_ShipDesignComponents.GameID = :game and FCT_ShipDesignComponents.ComponentTypeID = ${typeId} order by FCT_ShipDesignComponents.SDComponentID`

// The query binds :race only when it joins through FCT_RaceTech.
const componentParameters = (parameters, allGame) => (allGame ? { ':game': parameters[':game'] } : parameters)

const named = (row) => ({ id: row.SDComponentID, name: row.Name })

const checkEngines = async (context) => {
  const { database, rules, techs, parameters, allGame } = context
  const report = new Report('engine', RULE_IDS.engine)
  const rows = await all(database, componentsSql(allGame, 1), componentParameters(parameters, allGame))
  const shippingLine = rows.filter((row) => row.ShippingLineSystem).length

  report.notes.push(`scope: ${allGame ? 'every engine of the game' : 'the race\'s engines, held through FCT_RaceTech'}; ${shippingLine} shipping-line engine(s) among them`)

  for (const row of rows) {
    const identity = named(row)
    const engineTech = techs.get(row.BGTech1)
    const fuelTech = techs.get(row.BGTech2)
    const thermalTech = techs.get(row.BGTech3)

    report.checked++

    if (!engineTech || !fuelTech || !thermalTech) {
      report.skip(identity, `tech row missing (BGTech1..3 = ${row.BGTech1}, ${row.BGTech2}, ${row.BGTech3})`)
      continue
    }

    const design = rules.engineDesign({ sizeHS: row.Size, thrust: row.EnginePowerMod, engineTech: engineTech.AdditionalInfo, fuelTech: fuelTech.AdditionalInfo, thermalTech: thermalTech.AdditionalInfo, thermalCost: thermalTech.AdditionalInfo2 })
    const explain = engineExplainer(thermalTech)

    report.compare(identity, 'power', row.ComponentValue, design.power, 'decimal', explain)
    report.compare(identity, 'fuelEfficiency', row.FuelEfficiency, design.fuelPerEph, 'decimal', explain)
    report.compare(identity, 'cost', row.Cost, design.cost, 'decimal', explain)
    report.compare(identity, 'crew', row.Crew, design.crew, 'integer', explain)
    report.compare(identity, 'htk', row.HTK, design.htk, 'integer', explain)
    report.compare(identity, 'explosionChance', row.ExplosionChance, design.explosionChance, 'integer', explain)
    report.compare(identity, 'maxExplosion', row.MaxExplosionSize, design.maxExplosion, 'integer', explain)
    report.compare(identity, 'thermal', row.StealthRating, thermalTech.AdditionalInfo, 'decimal', explain)
    report.compare(identity, 'military', row.MilitarySystem, design.commercial ? 0 : 1, 'flag', explain)
  }

  return report
}

// A stored thermal share under the share of the engine's own thermal tech, where the tech is the "no reduction" row: the modded sample's M-series engines carry 0.08 (the planners read the stored share for an existing engine and the tech's for a designed one).
const engineExplainer = (thermalTech) => (field, stored) => (field === 'thermal' && thermalTech.AdditionalInfo === 1 && stored < 1 ? `StealthRating ${stored} is below its thermal tech's share of 1, set outside the design rule (modded sample)` : null)

const checkSpeeds = async (context) => {
  const { database, rules, parameters } = context
  const report = new Report('speed', RULE_IDS.speed)
  const classes = await all(database, 'select ShipClassID, ClassName, Size, EnginePower, MaxSpeed from FCT_ShipClass where GameID = :game and RaceID = :race order by ShipClassID', parameters)
  const engineTotals = await classEngineTotals(database, parameters)

  for (const row of classes) {
    const identity = { id: row.ShipClassID, name: row.ClassName }
    const totals = engineTotals.get(row.ShipClassID)

    report.checked++

    // The game speeds a class from the exact sum of its engines' power, so the speed comes from the sum of the class's engine rows. The 2.7.1 saves keep that sum in FCT_ShipClass.EnginePower as a whole number, cut (an INTEGER column); the 2.7.0 save keeps it exact. A class without engines keeps the game's starting speed of 1.
    const power = totals ? totals.power : 0
    const expected = totals ? rules.classSpeed({ enginePower: power, sizeHS: row.Size }) : 1

    report.compare(identity, 'maxSpeed', row.MaxSpeed, expected, 'integer', null)
    report.compare(identity, 'enginePower', row.EnginePower, Number.isInteger(row.EnginePower) ? Math.floor(power + 1e-9) : power, 'decimal', null)
  }

  return report
}

// Per class: the engines it carries, the count-weighted total power, and the engine rows themselves. Classes without an engine row are absent.
const classEngineTotals = async (database, parameters) => {
  const rows = await all(database, 'select FCT_ClassComponent.ClassID, FCT_ClassComponent.NumComponent, FCT_ShipDesignComponents.SDComponentID, FCT_ShipDesignComponents.ComponentValue, FCT_ShipDesignComponents.FuelEfficiency from FCT_ClassComponent inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ClassComponent.ClassID inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ShipClass.GameID = :game and FCT_ShipClass.RaceID = :race and FCT_ShipDesignComponents.ComponentTypeID = 1', parameters)
  const totals = new Map()

  for (const row of rows) {
    const total = totals.get(row.ClassID) || { power: 0, engines: [] }

    total.power += row.NumComponent * row.ComponentValue
    total.engines.push({ id: row.SDComponentID, count: row.NumComponent, fuelEfficiency: row.FuelEfficiency })
    totals.set(row.ClassID, total)
  }

  return totals
}

const checkRanges = async (context) => {
  const { database, rules, parameters } = context
  const report = new Report('range', RULE_IDS.range, INPUT_ONLY.range)
  const classes = await all(database, 'select ShipClassID, ClassName, Size, EnginePower, FuelEfficiency, FuelCapacity, MaxSpeed from FCT_ShipClass where GameID = :game and RaceID = :race order by ShipClassID', parameters)
  const engineTotals = await classEngineTotals(database, parameters)
  const ranges = []

  for (const row of classes) {
    const totals = engineTotals.get(row.ShipClassID)

    if (!totals || !(row.FuelCapacity > 0)) {
      continue
    }

    const identity = { id: row.ShipClassID, name: row.ClassName }
    const efficiencies = totals.engines.map((engine) => engine.fuelEfficiency)

    report.checked++

    // The class keeps the efficiency of one engine; the game takes the last engine it reads, an order the save does not keep, so a class of mixed engines matches any of them.
    const matches = efficiencies.some((value) => close(row.FuelEfficiency, value))

    if (!matches) {
      report.compare(identity, 'fuelEfficiency', row.FuelEfficiency, efficiencies[efficiencies.length - 1], 'decimal', null)
    } else if (new Set(efficiencies.map((value) => value.toPrecision(9))).size > 1) {
      report.notes.push(`${row.ShipClassID} "${row.ClassName}" mixes engines of different efficiency; its stored value matches one of them`)
    }

    ranges.push({ ...row, rangeKm: rules.fullPowerRangeKm({ fuel: row.FuelCapacity, enginePower: totals.power, fuelPerEph: row.FuelEfficiency, speed: row.MaxSpeed }) })
  }

  const shown = ranges.filter((row) => NAMED_CLASSES.includes(row.ShipClassID))

  for (const row of [...ranges].sort((a, b) => b.rangeKm - a.rangeKm).slice(0, 3)) {
    if (!shown.includes(row)) {
      shown.push(row)
    }
  }

  for (const row of shown) {
    report.notes.push(`range ${row.ShipClassID} "${row.ClassName}": ${(row.rangeKm / 1e9).toFixed(2)} bn km (${row.FuelCapacity} L, ${row.EnginePower} EP, ${format(row.FuelEfficiency)} L/EPH, ${row.MaxSpeed} km/s)`)
  }

  return report
}

// The game rounds a commercial drive's size to 2 decimals, and the 2.7.0 save's own drives show it; the drives of older games (the 2.6 saves, and game 138 of the 2.7.x saves) keep 1 decimal, so they were designed under an older rule. Only a size equal to the unrounded size cut to 1 decimal is explained.
const jumpExplainer = (rules, commercial, shipSizeHS, design) => (field, stored) => {
  if (field !== 'size' || !commercial) {
    return null
  }

  const unrounded = shipSizeHS / design.modifiedEfficiency * rules.COMMERCIAL_JUMP_MULTIPLIER

  return close(stored, rules.roundHalfEven(unrounded, 1)) ? 'commercial drive size rounded to 1 decimal: designed under the older rule (the game now rounds to 2)' : null
}

const checkJumpDrives = async (context) => {
  const { database, rules, techs, parameters, allGame } = context
  const report = new Report('jump', RULE_IDS.jump)
  const rows = await all(database, componentsSql(allGame, 16), componentParameters(parameters, allGame))

  report.notes.push(`scope: ${allGame ? 'every jump drive of the game' : 'the race\'s jump drives, held through FCT_RaceTech'}`)

  for (const row of rows) {
    const identity = named(row)
    const efficiency = techs.get(row.BGTech1)
    const squadronSize = techs.get(row.BGTech2)
    const squadronRadius = techs.get(row.BGTech3)
    const driveType = techs.get(row.BGTech4)

    report.checked++

    if (!efficiency || !squadronSize || !squadronRadius || !driveType) {
      report.skip(identity, `tech row missing (BGTech1..4 = ${row.BGTech1}, ${row.BGTech2}, ${row.BGTech3}, ${row.BGTech4})`)
      continue
    }

    const commercial = driveType.AdditionalInfo === 1
    const design = rules.jumpDriveDesign({ shipSizeHS: row.ComponentValue / (commercial ? rules.COMMERCIAL_JUMP_MULTIPLIER : 1), efficiency: efficiency.AdditionalInfo, squadronSizeCost: squadronSize.AdditionalInfo2, squadronRadiusCost: squadronRadius.AdditionalInfo2, commercial })

    const explain = jumpExplainer(rules, commercial, row.ComponentValue / rules.COMMERCIAL_JUMP_MULTIPLIER, design)

    report.compare(identity, 'size', row.Size, design.sizeHS, 'decimal', explain)
    report.compare(identity, 'cost', row.Cost, design.cost, 'decimal', explain)
    report.compare(identity, 'crew', row.Crew, design.crew, 'integer', explain)
    report.compare(identity, 'htk', row.HTK, design.htk, 'integer', explain)
    report.compare(identity, 'capacity', row.ComponentValue, design.capacityHS, 'decimal', explain)
  }

  return report
}

// Per class: its rows of components as the save stores them, joined to their design components. `missing` counts class rows whose design component is not in the save.
const classComponentRows = async (database, parameters) => {
  const rows = await all(database, 'select FCT_ClassComponent.ClassID, FCT_ClassComponent.ComponentID, FCT_ClassComponent.NumComponent, FCT_ClassComponent.ChanceToHit, FCT_ShipDesignComponents.SDComponentID, FCT_ShipDesignComponents.Name, FCT_ShipDesignComponents.ComponentTypeID, FCT_ShipDesignComponents.Size, FCT_ShipDesignComponents.ComponentValue, FCT_ShipDesignComponents.Cost from FCT_ClassComponent inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_ClassComponent.ClassID left join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ShipClass.GameID = :game and FCT_ShipClass.RaceID = :race order by FCT_ClassComponent.ClassID, FCT_ClassComponent.ChanceToHit, FCT_ClassComponent.ComponentID', parameters)
  const classes = new Map()

  for (const row of rows) {
    const entry = classes.get(row.ClassID) || { rows: [], missing: 0 }

    if (row.SDComponentID === null) {
      entry.missing++
    } else {
      entry.rows.push(row)
    }

    classes.set(row.ClassID, entry)
  }

  return classes
}

// A stored figure the rule cannot give for a reason in the class itself is explained by that reason; the rule's own unavailable result names it.
const unavailableReason = (result) => result.inputs.missing.join('; ')

const checkMaintenance = async (context) => {
  const { database, rules, parameters } = context
  const report = new Report('maintenance', RULE_IDS.maintenance)
  const classes = await all(database, 'select ShipClassID, ClassName, Size, Cost, Commercial, MaintSupplies, BaseFailureChance, MaxDACRoll from FCT_ShipClass where GameID = :game and RaceID = :race order by ShipClassID', parameters)
  const components = await classComponentRows(database, parameters)
  const branches = { commercial: 0, military: 0, noEngineering: 0, noStorage: 0 }
  const lives = []

  for (const row of classes) {
    const identity = { id: row.ShipClassID, name: row.ClassName }
    const entry = components.get(row.ShipClassID) || { rows: [], missing: 0 }

    report.checked++

    if (entry.missing) {
      report.skip(identity, `${entry.missing} of the class's component rows have no design component in the save`)
      continue
    }

    const ofType = (type) => entry.rows.filter((component) => component.ComponentTypeID === type)
    const engineeringValue = ofType(rules.ENGINEERING_COMPONENT_TYPE).reduce((total, component) => total + component.NumComponent * component.ComponentValue, 0)
    const storage = ofType(rules.MAINTENANCE_STORAGE_COMPONENT_TYPE).map((component) => ({ value: component.ComponentValue, count: component.NumComponent }))
    const sizeHS = row.Size
    const failureRate = rules.annualFailureRate({ sizeHS, engineeringValue })
    const supplies = rules.classMaintenanceSupplies({ sizeHS, cost: row.Cost, engineeringValue, storage })
    // Armour first at threshold 0, then each component by its stored threshold: the order the game's table has, so the rule's thresholds are comparable one for one.
    const ordered = [...entry.rows].sort((a, b) => (b.ComponentTypeID === rules.ARMOUR_COMPONENT_TYPE) - (a.ComponentTypeID === rules.ARMOUR_COMPONENT_TYPE) || a.ChanceToHit - b.ChanceToHit)
    const allocation = rules.damageAllocation({ components: ordered.map((component) => ({ sizeHS: component.Size, count: component.NumComponent, armour: component.ComponentTypeID === rules.ARMOUR_COMPONENT_TYPE })) })

    branches[row.Commercial ? 'commercial' : 'military']++

    if (engineeringValue === 0) {
      branches.noEngineering++
    }

    if (!storage.length) {
      branches.noStorage++
    }

    if (rules.isAvailable(failureRate)) {
      report.compare(identity, 'baseFailureChance', row.BaseFailureChance, failureRate.value, 'decimal', null)
    } else {
      report.skip(identity, `no annual failure rate: ${unavailableReason(failureRate)}`)
    }

    if (rules.isAvailable(supplies)) {
      report.compare(identity, 'maintSupplies', row.MaintSupplies, supplies.value, 'integer', null)
    } else {
      report.skip(identity, `no maintenance supplies: ${unavailableReason(supplies)}`)
    }

    if (rules.isAvailable(allocation)) {
      report.compare(identity, 'maxDacRoll', row.MaxDACRoll, allocation.value.maxDacRoll, 'integer', null)
      ordered.forEach((component, index) => report.compare(identity, `chanceToHit of ${component.SDComponentID}`, component.ChanceToHit, allocation.value.chanceToHit[index], 'integer', null))
    } else {
      report.skip(identity, `no damage allocation: ${unavailableReason(allocation)}`)
    }

    if (!row.Commercial && rules.isAvailable(allocation)) {
      const repairCost = rules.averageRepairCost({ components: entry.rows.map((component) => ({ chanceToHit: component.ChanceToHit, cost: component.Cost })), maxDacRoll: row.MaxDACRoll })
      const life = rules.maintenanceLifeSeries({ commercial: row.Commercial, baseFailureChance: row.BaseFailureChance, averageRepairCost: repairCost.value, maintSupplies: row.MaintSupplies })

      if (rules.isAvailable(life)) {
        lives.push({ ...identity, repairCost: repairCost.value, supplies: row.MaintSupplies, life: life.value })
      } else {
        report.notes.push(`${identity.id} "${identity.name}" has no maintenance life: ${unavailableReason(life)}`)
      }
    }
  }

  report.notes.unshift(`classes: ${branches.military} military, ${branches.commercial} commercial; ${branches.noEngineering} without engineering, ${branches.noStorage} without maintenance storage`)

  for (const row of [...lives].sort((a, b) => b.supplies - a.supplies).slice(0, 3)) {
    report.notes.push(`life ${row.id} "${row.name}": ${row.life.life} years on ${row.supplies} MSP, average repair ${format(row.repairCost)} MSP, ${format(row.life.firstYear)} MSP in year 1, ${format(row.life.fiveYear)} MSP in 5 years`)
  }

  return report
}

// ---------- missile designs ----------

// The rules, loaders and comparison of the missile checks, loaded from the utilities (design-rules, design-data, provenance, missile-hit) and the reconciliation of scripts/lib: one flat library of what the checks call. `utilities` and `library` name other copies of the two folders, for a check that plants a fault in one.
const loadMissileLibrary = async ({ utilities = UTILITIES, library = MISSILE_LIBRARY } = {}) => {
  const loaded = await loadUtilities(['design-rules', 'design-data', 'provenance', 'missile-hit'], { directory: utilities })
  const { 'missile-reconcile': reconcile, 'sensor-reconcile': sensorReconcile } = await loadUtilities(['missile-reconcile', 'sensor-reconcile'], { directory: library })
  const rules = loaded['design-rules']
  const data = loaded['design-data']

  return { ...rules, ...data, ...reconcile.createMissileReconciler({ rules, data }), ...sensorReconcile.createSensorReconciler({ rules, data, basis: reconcile.BASIS }), provenance: loaded.provenance, hit: loaded['missile-hit'] }
}

const groupBy = (entries, keyOf) => {
  const groups = new Map()

  for (const entry of entries) {
    const key = keyOf(entry)

    groups.set(key, [...(groups.get(key) || []), entry])
  }

  return [...groups.values()]
}

// The missile rules' report. A comparison is judged by the library (`classify`): 'agree' and 'differ' count as checked, a 'differ' is explained (by the comparison itself or a row of KNOWN_MISSILE_ROWS, which holds only at its audited figures) or a mismatch, and the other two verdicts are counted apart and never as agreement: 'unsupported' (a case the rules do not cover) and 'unknown' (a figure the save or the rules cannot give, never read as 0). `resolvedFromStored` counts the checked comparisons whose technology level was picked by matching the very figure compared: they are in `checked` and show that some held level gives the figure, not that the rule does.
class MissileReport extends Report {
  constructor (rule, ruleIds, scope, library, game, known = KNOWN_MISSILE_ROWS) {
    super(rule, ruleIds, scope)
    this.library = library
    this.game = game
    this.known = known
    this.unsupported = []
    this.unknown = []
    this.resolvedFromStored = 0
  }

  close (stored, computed) {
    return this.library.agrees(stored, computed)
  }

  record (row, entry) {
    const { verdict, reason } = this.library.classify(this.known, this.game, row.id, entry)
    const shown = { id: row.id, name: row.name, field: entry.field, stored: format(entry.stored), computed: format(entry.computed) }

    if (verdict === 'unsupported') {
      this.unsupported.push({ ...shown, reason: entry.unsupported })

      return verdict
    }

    if (verdict === 'unknown') {
      this.unknown.push({ ...shown, reason: entry.computed === null ? (entry.reason || `the rules do not give ${entry.field}`) : `the save stores no ${entry.field}` })

      return verdict
    }

    this.checked++

    if (entry.basis === this.library.BASIS.RESOLVED) {
      this.resolvedFromStored++
    }

    if (verdict === 'differ') {
      if (reason) {
        this.explained.push({ ...shown, reason })
      } else {
        this.mismatches.push(shown)
      }
    }

    return verdict
  }

  tally () {
    return `, ${this.unsupported.length} unsupported, ${this.unknown.length} unknown; ${this.resolvedFromStored} of the checked resolved from the stored figure`
  }

  printMore () {
    for (const [label, entries] of [['unsupported', this.unsupported], ['unknown', this.unknown]]) {
      for (const group of groupBy(entries, (entry) => `${entry.id}|${entry.reason}`)) {
        console.log(`  ${label} ${group[0].id} "${group[0].name}" ${group.map((entry) => entry.field).join(', ')} - ${group[0].reason}`)
      }
    }
  }
}

const known = (value) => (value === null ? '?' : format(value))

// A contribution as "name msp MSP bp BP", unknown figures as "?".
const ledgerText = (ledger, names) => names.filter((name) => ledger[name].msp !== 0 || ledger[name].bp !== 0).map((name) => `${name} ${known(ledger[name].msp)} MSP ${known(ledger[name].bp)} BP`).join(', ')

const levelText = (lines) => Object.entries(lines).filter(([, line]) => line.state === 'resolved').map(([name, line]) => `${name} ${line.level.info}${line.historical ? ` (historical, current ${line.current.info})` : ''}`).join(', ')

const LEDGER_ORDER = ['engine', 'fuel', 'warhead', 'reactor', 'active', 'thermal', 'em', 'geo', 'decoys', 'extraWarheads', 'secondStage', 'eccm', 'terminal', 'retarget', 'laser']

// Every comparison of a fixture's designs and engines, in a report. A design that only supplies a second stage to another is read, not reported.
const reconcileFixture = (library, fixture, scope, { ledger = false, ruleIds = RULE_IDS.missile } = {}) => {
  const report = new MissileReport('missile', ruleIds, scope, library, fixture.game)
  const designs = fixture.designs.filter((design) => !design.stageOnly)
  const engines = new Set()
  const results = []
  let historical = 0

  for (const design of designs) {
    const component = fixture.components[design.row.EngineID]

    if (component && !engines.has(component.id)) {
      engines.add(component.id)

      const engine = library.reconcileEngine(fixture, component, { thrust: design.row.PowerMod, race: design.race })

      engine.comparisons.forEach((entry) => report.record({ id: engine.id, name: engine.name }, entry))
    }

    const result = library.reconcileMissile(fixture, design)

    results.push(result)
    result.comparisons.forEach((entry) => report.record({ id: result.id, name: result.name }, entry))
    historical += Object.values(result.lines).filter((line) => line.historical).length
  }

  const stageOnly = fixture.designs.length - designs.length

  report.notes.push(`scope: ${designs.length} missile designs${stageOnly ? `, ${stageOnly} more read only for the size of a second stage` : ''}, each rebuilt from the levels its race holds, not the race's current best; ${engines.size} missile engines`)
  report.notes.push(`levels: ${historical} resolved lines are a level the race has since passed (historical)`)

  if (ledger) {
    for (const result of results) {
      const fromStored = result.comparisons.filter((entry) => entry.basis === library.BASIS.RESOLVED && library.judge(entry) !== 'unknown').map((entry) => entry.field)

      report.notes.push(`ledger ${result.id} "${result.name}": size ${known(result.figures.size)}, cost ${known(result.figures.cost)}: ${ledgerText(result.ledger, LEDGER_ORDER)}; levels: ${levelText(result.lines)}; resolved from the stored figure: ${fromStored.length ? fromStored.join(', ') : 'none'}`)
    }
  }

  return report
}

// The loaders of utilities/design-data.js read through the app's database object, `query(sql, { replacements })` giving `[rows]` with `:name` placeholders: this is that object over the read-only sqlite3 handle.
const appDatabase = (database) => ({ query: async (sql, { replacements = {} } = {}) => [await all(database, sql, Object.fromEntries(Object.entries(replacements).map(([name, value]) => [`:${name}`, value])))] })

// The fixture of the scope's designs, read by the loaders of utilities/design-data.js.
const loadSavedFixture = async (library, database, parameters, allGame) => {
  const store = appDatabase(database)

  return library.loadMissileFixture(store, parameters[':game'], await library.ownedMissiles(store, parameters[':game'], allGame ? null : parameters[':race']))
}

const checkMissiles = async (context) => {
  const { database, parameters, allGame, library, ledger } = context
  const fixture = await loadSavedFixture(library, database, parameters, allGame)

  return reconcileFixture(library, fixture, allGame ? 'every missile design of the game, each with the techs of the race that researched it' : 'the missile designs the race researched', { ledger })
}

// Writes the designs of the scope (the race's, or every design of the game with --all-game) as a fixture under `options.label` in the fixtures file, replacing a fixture of that label and keeping the others. The saves are not tracked and the fixtures are, so the checks of the rules and their mutants run without a save.
const exportMissileFixture = async (context, options) => {
  const { database, parameters, allGame, library } = context
  const fixture = await loadSavedFixture(library, database, parameters, allGame)
  const existing = fs.existsSync(options.exportFile) ? JSON.parse(fs.readFileSync(options.exportFile, 'utf8')) : { fixtures: [] }
  const entry = { label: options.label, save: path.basename(options.save), game: parameters[':game'], note: options.note, scope: allGame ? 'every missile design of the game' : `the missile designs of race ${parameters[':race']}`, ...fixture }
  const fixtures = [...existing.fixtures.filter((held) => held.label !== options.label), entry].sort((a, b) => a.label.localeCompare(b.label))

  fs.writeFileSync(options.exportFile, `${JSON.stringify({ fixtures })}\n`)

  return { designs: fixture.designs.length, races: Object.keys(fixture.races).length, components: Object.keys(fixture.components).length }
}

// ---------- the checks of the missile rules on the fixtures, and the mutants of the library ----------

const loadFixtures = () => new Map(JSON.parse(fs.readFileSync(MISSILE_FIXTURES, 'utf8')).fixtures.map((fixture) => [fixture.label, fixture]))

const clone = (value) => JSON.parse(JSON.stringify(value))

const designOf = (fixture, id) => fixture.designs.find((design) => design.id === id)

const entryOf = (result, field) => result.comparisons.find((entry) => entry.field === field)

// A check passes when it returns true; any other result is the reason it failed.
const firstFailure = (...results) => results.find((result) => result !== true) ?? true

const near = (actual, expected) => actual !== null && actual !== undefined && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected))

const expectNear = (what, actual, expected) => (near(actual, expected) ? true : `${what} is ${actual}, expected ${expected}`)

const expectThat = (what, held) => (held ? true : what)

const expectVerdicts = (library, result, fields, verdict) => {
  const verdictOf = (field) => {
    const entry = entryOf(result, field)

    return entry ? library.judge(entry) : 'missing'
  }
  const wrong = fields.filter((field) => verdictOf(field) !== verdict)

  return wrong.length ? `${result.name}: ${wrong.map((field) => `${field} is ${verdictOf(field)}`).join(', ')}, expected ${verdict}` : true
}

const levelInfo = (line) => line?.level?.info ?? null

const outcome = (test) => {
  try {
    return test()
  } catch (error) {
    return `threw ${error.message}`
  }
}

// A design with nothing in it, for the rules that a design of the saves does not isolate.
const plainInput = (overrides = {}) => ({ warheadMsp: 0, warheads: 1, shipDecoy: false, decoys: 0, fuelMsp: 0, activeMsp: 0, thermalMsp: 0, emMsp: 0, geoMsp: 0, sizeLimit: 0, engine: null, engines: 0, stage: null, stages: 0, options: { eccm: 0, terminal: 1, retarget: 0, laser: false }, tech: { warhead: 1, laserEfficiency: null, reactor: null, active: null, thermal: null, em: null, geo: null }, ...overrides })

const CHECK_NAMES = {
  twelve: 'the Arrow and the Spear of the modded save are 12 MSP with their add-ons',
  addOns: 'the ECCM, terminal guidance and laser add-ons of the Arrow are 0.25 MSP each and carry their own cost',
  retargeting: 'retargeting is 0.5 MSP and costs 0.5 of Uridium at level 1 only',
  historical: 'a design is rebuilt from the level its race held, not from the level it holds now',
  reactor: 'the reactor of a sensor is a fifth of its strength over the power plant tech times 0.05',
  rounding: 'a midpoint is rounded to the even neighbour',
  thrust: 'the thrust above the greatest thrust modifier burns more fuel, and the modifier is the held level that reproduces the stored fuel use',
  settledThrust: 'the greatest thrust modifier is 3 for the modded Arrow and 2.5 for race 785',
  stockArrow: 'the speed, endurance and range of the stock Arrow reproduce at the rounding points of the rules',
  fuel: 'the fuel carried is cut to a whole litre',
  capAndFloor: 'the speed is capped at 270000 and the size floors at 1',
  decoy: 'a ship decoy is 200 strength a MSP, 4 BP a MSP of Corbomite, and 5 MSP at least',
  extraWarhead: 'a warhead after the first adds 0.1 MSP, Tritanium and BP, and a save that stores none for it is explained, not in agreement',
  stage: 'a second stage adds its size, cost, minerals and fuel once for each, and its flight time',
  noReactor: 'a power plant tech the race does not hold leaves the reactor and the size unknown, not 0',
  unsupported: 'a ground attack pod and an enhanced radiation warhead are unsupported, never agreement',
  nullMineral: 'a mineral the save stores as null is unknown, not 0',
  corundium: 'the Corundium of a laser warhead is the cost beyond the stored minerals',
  sizeLimit: 'a size limit of the designer explains an oversize sum only where the stored speed follows',
  noEngine: 'an engine component the save lacks leaves the engine cost, speed and range unknown, not 0',
  sensorRange: 'an active sensor range is the root of strength, EM sensitivity and resolution to the 2/3',
  emGeo: 'EM and geo sensors reproduce with their reactor',
  decoys: 'ECM decoys are 0.5 MSP and 1 BP of Corbomite each',
  recorded: 'a recorded level the race does not hold is unknown, not a difference',
  everything: 'every design of every fixture reproduces its stored figures, apart from the differences and unknown figures pinned by design, field and reason',
  engines: 'every missile engine of every fixture reproduces its power, cost and fuel use at its thrust',
  tolerance: 'figures agree at 1e-9 of the larger',
  noWarhead: 'a design with no warhead has a strength of 0 and a sensor under a quarter MSP has none',
  unresolved: 'a stored figure no held level gives leaves what follows from the level unknown',
  noStage: 'a second stage the save lacks leaves the size, cost and fuel unknown, not 0',
  engineMsp: 'the engine of the Arrow is 6 MSP and 15 BP, half of it Boronide and half Gallicite',
  pinnedLoss: 'a figure of a fixture moved off its stored value is found by the fixture-wide check',
  known: 'a pinned difference is explained only at its audited game, design, field and figures',
  sizeRounding: 'an oversize is a size limit only where it equals the 4-decimal rounding of the engine size',
  lines: 'a line whose tech type the race does not hold is reported as an unknown level',
  basis: 'a figure rebuilt from a level picked by matching a stored figure is marked resolved from the stored figure',
  roundTrip: 'every saved design evaluated as a candidate gives the size, cost and minerals of its reconciliation, and the options add up to the totals and to the stored figures',
  overBudget: 'a candidate over its size, cost or mineral budget is rejected before ranking, and one at its limits is feasible',
  unknownAccounting: 'a candidate with an option whose accounting is unknown has no feasibility, whatever its budget, and is not admitted',
  mounting: 'a saved design counts the engine and the second stages its row shows mounted, whatever record is given: an absent record is unknown, never none, and a contradiction is refused',
  unsupportedOptions: 'a ground pod, an enhanced radiation warhead and a retargeting level above 1 are unsupported: no feasibility, no total, never 0',
  efficacy: 'only an effect whose rule is confirmed counts, a targeting effect that is not verified is listed and counts for nothing, and no score is made',
  validation: 'a candidate or budget that is not valid is refused, and a tech that is not known is not',
  registered: 'the missile rules are registered with the verification the evidence supports',
  provenance: 'a figure beyond what the fixtures reproduce is estimated, one inside it confirmed; the feasibility takes the weakest of the figures it compared, and an estimated effect is not counted',
}

const N = CHECK_NAMES

// The base comparisons every design of the fixtures carries, whatever it is made of.
const BASE_FIELDS = ['Size', 'MSPEngine', 'MSPReactor', 'MSPDecoys', 'MSPMultipleWarheads', 'WarheadStrength', 'RadDamage', 'LaserWarhead', 'SensorStrength', 'ThermalStrength', 'EMStrength', 'Geostrength', 'SensorRange', 'Cost', 'Corbomite', 'Tritanium', 'Boronide', 'Uridium', 'Gallicite', 'UnstoredMinerals', 'Speed', 'Endurance', 'MaxRange', 'FuelRequired', 'TotalFlightTime']

const pinKeys = (label, ids, fields) => ids.flatMap((id) => fields.map((field) => `${label}|${id}|${field}`))

// Every comparison of the fixtures that is not in agreement, as `fixture|design|field`: the differences that are explained (by the comparison or a pinned row) and the figures that stay unknown. A comparison that moves in or out of these is a change to look at, not one to absorb.
const EXPECTED_DIFFER = new Set([
  ...pinKeys('modded-g140', [500724], ['Cost', 'Uridium', 'UnstoredMinerals']),
  ...pinKeys('modded-g140', [500726, 500728], ['MSPMultipleWarheads']),
  ...pinKeys('stock-271-g138', [154678], ['Endurance', 'MaxRange', 'TotalFlightTime']),
  ...pinKeys('v270-kristover-g139', [153793], ['Size']),
  ...pinKeys('v270-kristover-g143', [154369], ['Size', 'MSPMultipleWarheads']),
])

const EXPECTED_UNKNOWN = new Set([
  ...pinKeys('modded-g140', [500956, 501116], ['Level:shipDecoy', 'Level:emSensitivity', 'Level:laserFocus', 'Level:missileEcm']),
  ...pinKeys('stock-271-g138', [154110, 154194], ['MSPEngine', 'EngineComponent', 'Cost', 'Boronide', 'Gallicite', 'Speed', 'Endurance', 'MaxRange', 'TotalFlightTime']),
  ...pinKeys('solid-core-g137', [153571], ['Level:multipleWarheads']),
  ...pinKeys('v270-kristover-g139', [153793], ['Level:multipleWarheads']),
  ...pinKeys('v270-kristover-g143', [154369], ['Level:multipleWarheads']),
])

// What is wrong with the fixtures `data` as the library reads them: an unsupported comparison, an unknown or a difference not pinned above, a difference with no reason, a pinned one that no longer holds, or a base comparison a design lacks.
const fixtureProblems = (library, data) => {
  const problems = []
  const seen = new Set()

  for (const fixture of data.values()) {
    for (const design of fixture.designs.filter((entry) => !entry.stageOnly)) {
      const result = library.reconcileMissile(fixture, design)
      const fields = new Set(result.comparisons.map((entry) => entry.field))

      for (const field of BASE_FIELDS.filter((held) => !fields.has(held))) {
        problems.push(`${fixture.label} ${design.id} lacks ${field}`)
      }

      for (const entry of result.comparisons) {
        const key = `${fixture.label}|${design.id}|${entry.field}`
        const { verdict, reason } = library.classify(KNOWN_MISSILE_ROWS, fixture.game, design.id, entry)

        if (verdict === 'unsupported') {
          problems.push(`${key} is unsupported`)
        } else if (verdict === 'unknown') {
          seen.add(key)

          if (!EXPECTED_UNKNOWN.has(key)) {
            problems.push(`${key} is unknown and not pinned`)
          }
        } else if (verdict === 'differ') {
          seen.add(key)

          if (!EXPECTED_DIFFER.has(key)) {
            problems.push(`${key} differs and is not pinned`)
          } else if (!reason) {
            problems.push(`${key} differs with no reason`)
          }
        }
      }
    }
  }

  for (const key of [...EXPECTED_DIFFER, ...EXPECTED_UNKNOWN].filter((pinned) => !seen.has(pinned))) {
    problems.push(`${key} is pinned and no longer differs or unknown`)
  }

  return problems
}

// The checks of the missile rules over the fixtures `data` (label to fixture), run on `library`: the real one, or a mutated copy that must fail the checks its mutant names. Each is [name, test], the test returning true or the reason it failed.
const reconciliationChecks = (library, data) => {
  const modded = data.get('modded-g140')
  const stock = data.get('stock-271-g138')
  const older = data.get('solid-core-g137')
  const older138 = data.get('solid-core-g138')
  const kristover = data.get('v270-kristover-g143')
  const rebuilt = (fixture, id) => library.reconcileMissile(fixture, designOf(fixture, id))
  const totalMsp = (result) => library.CONTRIBUTIONS.reduce((total, name) => total + result.ledger[name].msp, 0)
  const edited = (fixture, id, edit) => {
    const copy = clone(fixture)
    const design = designOf(copy, id)

    edit(copy, design)

    return { copy, design, result: library.reconcileMissile(copy, design) }
  }
  const engineOf = (fixture, id) => {
    const design = fixture.designs.find((entry) => entry.row.EngineID === id)

    return library.reconcileEngine(fixture, fixture.components[id], { thrust: design.row.PowerMod, race: design.race })
  }

  return [
    [N.twelve, () => firstFailure(...[154261, 154264].map((id) => {
      const result = rebuilt(modded, id)

      return firstFailure(expectNear(`${result.name} size`, result.figures.size, 12), expectNear(`${result.name} sum of the contributions`, totalMsp(result), 12), expectVerdicts(library, result, ['Size', 'Cost', 'Corbomite', 'Tritanium', 'Boronide', 'Uridium', 'Gallicite', 'UnstoredMinerals'], 'agree'))
    }))],
    [N.addOns, () => {
      const { ledger, lines } = rebuilt(modded, 154261)

      return firstFailure(expectNear('ECCM size', ledger.eccm.msp, 0.25), expectNear('ECCM Corbomite', ledger.eccm.minerals.Corbomite, 0.15), expectNear('terminal guidance size', ledger.terminal.msp, 0.25), expectNear('terminal guidance Uridium', ledger.terminal.minerals.Uridium, 0.4), expectNear('laser size', ledger.laser.msp, 0.25), expectNear('laser Corundium', ledger.laser.minerals.Corundium, 0.6), expectNear('laser efficiency level', levelInfo(lines.laserEfficiency), 60), expectNear('retargeting size', ledger.retarget.msp, 0))
    }],
    [N.retargeting, () => {
      const levelOne = library.missileAccounting(plainInput({ options: { eccm: 0, terminal: 1, retarget: 1, laser: false } })).contributions.retarget
      const levelTwo = library.missileAccounting(plainInput({ options: { eccm: 0, terminal: 1, retarget: 2, laser: false } })).contributions.retarget

      return firstFailure(expectNear('level 1 size', levelOne.msp, 0.5), expectNear('level 1 Uridium', levelOne.minerals.Uridium, 0.5), expectNear('level 2 size', levelTwo.msp, 0.5), expectNear('level 2 Uridium', levelTwo.minerals.Uridium, 0), expectVerdicts(library, rebuilt(stock, 153731), ['Size', 'Uridium', 'Cost'], 'agree'))
    }],
    [N.historical, () => {
      const result = rebuilt(stock, 153728)
      const warhead = result.lines.warhead

      return firstFailure(expectThat('the warhead line is not resolved', warhead.state === 'resolved'), expectNear('warhead level', levelInfo(warhead), 4), expectThat('the line is not marked historical', warhead.historical === true), expectThat('the level of the race now is not above the level of the design', (warhead.current?.info ?? 0) > 4), expectVerdicts(library, result, ['WarheadStrength', 'Tritanium', 'Cost'], 'agree'))
    }],
    [N.reactor, () => {
      const { ledger, lines } = rebuilt(modded, 154261)

      return firstFailure(expectNear('reactor size', ledger.reactor.msp, 0.072), expectNear('reactor BP', ledger.reactor.bp, 0.108), expectNear('reactor Boronide', ledger.reactor.minerals.Boronide, 0.108), expectNear('power plant level', levelInfo(lines.reactor), 10), expectVerdicts(library, rebuilt(stock, 153826), ['MSPReactor', 'ThermalStrength', 'Boronide'], 'agree'))
    }],
    [N.rounding, () => firstFailure(expectNear('0.125 at 2 decimals', library.roundHalfEven(0.125, 2), 0.12), expectNear('0.175 at 2 decimals', library.roundHalfEven(0.175, 2), 0.18), expectNear('2.5 at 0 decimals', library.roundHalfEven(2.5, 0), 2), expectNear('the strength of a 0.25 MSP sensor of tech 10', library.missileSensorStrength({ sensorMsp: 0.25, sensorTech: 10 }), 0.12))],
    [N.thrust, () => firstFailure(...[154259, 154262].map((id) => {
      const engine = engineOf(modded, id)

      return firstFailure(expectThat(`engine ${id} has no greatest thrust modifier`, engine.maxThrust !== null), expectNear(`engine ${id} thrust`, engine.thrust, id === 154259 ? 4 : 6), expectVerdicts(library, { name: engine.name, comparisons: engine.comparisons }, ['EnginePower', 'EngineCost', 'FuelEfficiency'], 'agree'))
    }))],
    [N.settledThrust, () => firstFailure(expectNear('modded Arrow engine', engineOf(modded, 154259).maxThrust?.info, 3), expectNear('race 785 engine 154629', engineOf(stock, 154629).maxThrust?.info, 2.5))],
    [N.stockArrow, () => {
      const result = rebuilt(stock, 153728)

      return firstFailure(expectNear('speed', result.figures.speed, 16950), expectNear('endurance', result.figures.endurance, 1525.1), expectNear('range from the speed and the endurance rounded to 1 decimal', result.figures.maxRange, 16950 * 1525.1), expectNear('range', result.figures.maxRange, 25850445), expectVerdicts(library, result, ['Speed', 'Endurance', 'MaxRange', 'FuelRequired', 'Size', 'Cost'], 'agree'))
    }],
    [N.fuel, () => {
      const result = rebuilt(modded, 154261)

      return firstFailure(expectNear('litres carried', result.figures.fuelRequired, 2632), expectNear('endurance', result.figures.endurance, 2442.2), expectVerdicts(library, result, ['FuelRequired', 'Endurance', 'MaxRange', 'TotalFlightTime'], 'agree'))
    }],
    [N.capAndFloor, () => {
      const result = rebuilt(modded, 500726)

      const unit = library.missileAccounting(plainInput({ fuelMsp: 0.1, engine: { sizeMsp: 1, cost: 1, power: 100, fuelEfficiency: 1 }, engines: 1 })).figures

      return firstFailure(expectThat('the sum of the sizes is not under 1', result.figures.sizeSum < 1), expectNear('size', result.figures.size, 1), expectNear('speed', result.figures.speed, 270000), expectVerdicts(library, result, ['Size', 'Speed', 'Endurance', 'MaxRange'], 'agree'), expectNear('speed of an engine of 100 EP in 1.1 MSP, where no design of the saves is over the cap', unit.speed, 270000))
    }],
    [N.decoy, () => {
      const result = rebuilt(modded, 154198)
      const small = library.missileAccounting(plainInput({ shipDecoy: true, warheadMsp: 1 })).figures

      return firstFailure(expectNear('size', result.figures.size, 25), expectNear('strength of 25 MSP', result.figures.warheadStrength, 5000), expectNear('cost of 25 MSP', result.figures.cost, 100), expectVerdicts(library, result, ['Size', 'WarheadStrength', 'RadDamage', 'Cost', 'Corbomite', 'Speed'], 'agree'), expectNear('size of a 1 MSP decoy', small.size, 5), expectNear('cost of a 1 MSP decoy', small.cost, 4), expectVerdicts(library, rebuilt(older, 153501), ['Size', 'WarheadStrength', 'Cost'], 'agree'))
    }],
    [N.extraWarhead, () => {
      const result = rebuilt(older, 153571)
      const needle = rebuilt(modded, 500726)
      const unwritten = entryOf(needle, 'MSPMultipleWarheads')

      return firstFailure(expectNear('extra warheads size', result.ledger.extraWarheads.msp, 0.1), expectNear('extra warheads Tritanium', result.ledger.extraWarheads.minerals.Tritanium, 0.1), expectVerdicts(library, result, ['MSPMultipleWarheads', 'Size', 'Tritanium', 'Cost'], 'agree'), expectThat('a stored 0 is not a difference', Boolean(unwritten) && library.judge(unwritten) === 'differ'), expectThat('a stored 0 is not explained', Boolean(unwritten?.explain)), expectVerdicts(library, needle, ['Cost', 'Tritanium'], 'agree'))
    }],
    [N.stage, () => firstFailure(...[[stock, 154678, 9], [stock, 154676, 8], [older138, 154020, 1]].map(([fixture, id, count]) => {
      const result = rebuilt(fixture, id)
      const stageSize = designOf(fixture, designOf(fixture, id).row.SecondStageID).row.Size
      const flight = id === 154678 ? [] : ['TotalFlightTime']

      return firstFailure(expectNear(`${result.name} second stage size`, result.ledger.secondStage.msp, stageSize * count), expectVerdicts(library, result, ['Size', 'Cost', 'Tritanium', 'Uridium', 'Boronide', 'Gallicite', 'FuelRequired', ...flight], 'agree'))
    }))],
    [N.noReactor, () => {
      const { result } = edited(modded, 154261, (fixture) => { delete fixture.races[786].held[41] })

      return firstFailure(expectThat('the reactor size is not unknown', result.ledger.reactor.msp === null), expectVerdicts(library, result, ['MSPReactor', 'Size', 'Speed', 'MaxRange'], 'unknown'), expectVerdicts(library, result, ['Cost', 'Endurance'], 'agree'))
    }],
    [N.unsupported, () => {
      const ground = edited(modded, 154261, (_fixture, design) => { design.row.GroundShots = 1 })
      const radiation = edited(modded, 154261, (_fixture, design) => { design.row.RadDamage = 2 * design.row.WarheadStrength })
      const alone = { ...ground.copy, designs: [ground.design] }
      const report = reconcileFixture(library, alone, '')

      return firstFailure(expectThat('a ground pod comparison is judged', ground.result.comparisons.every((entry) => library.judge(entry) === 'unsupported')), expectVerdicts(library, radiation.result, ['WarheadStrength', 'RadDamage', 'LaserWarhead', 'Cost', 'Tritanium', 'UnstoredMinerals'], 'unsupported'), expectVerdicts(library, radiation.result, ['Size', 'Speed'], 'agree'), expectThat('the report counts a ground pod as checked', report.unsupported.length === ground.result.comparisons.length && report.mismatches.length === 0 && report.explained.length === 0))
    }],
    [N.nullMineral, () => {
      const { result } = edited(modded, 154261, (_fixture, design) => { design.row.Uridium = null })

      return firstFailure(expectVerdicts(library, result, ['Uridium', 'UnstoredMinerals'], 'unknown'), expectVerdicts(library, result, ['Boronide', 'Cost'], 'agree'))
    }],
    [N.corundium, () => {
      const result = rebuilt(modded, 154261)
      const residual = entryOf(result, 'UnstoredMinerals')

      return firstFailure(expectNear('stored cost beyond the stored minerals', residual.stored, 0.6), expectNear('Corundium of the rule', residual.computed, 0.6), expectVerdicts(library, rebuilt(stock, 154463), ['UnstoredMinerals', 'Cost'], 'agree'))
    }],
    [N.sizeLimit, () => {
      const result = rebuilt(kristover, 154369)
      const entry = entryOf(result, 'Size')
      const moved = edited(kristover, 154369, (_fixture, design) => { design.row.Speed = 1 })

      return firstFailure(expectThat('the size of the limited design is not a difference', Boolean(entry) && library.judge(entry) === 'differ'), expectThat('the size of the limited design is not explained', Boolean(entry?.explain)), expectVerdicts(library, result, ['Speed', 'Endurance'], 'agree'), expectThat('a speed that does not follow still explains the size', !moved.result.limited && !entryOf(moved.result, 'Size')?.explain))
    }],
    [N.noEngine, () => {
      const result = rebuilt(stock, 154110)
      const hidden = edited(stock, 153728, (fixture) => { delete fixture.components[153726] }).result

      return firstFailure(expectVerdicts(library, result, ['MSPEngine', 'EngineComponent', 'Cost', 'Boronide', 'Gallicite', 'Speed', 'Endurance', 'MaxRange'], 'unknown'), expectVerdicts(library, result, ['Size', 'Tritanium', 'UnstoredMinerals'], 'agree'), expectVerdicts(library, hidden, ['Cost', 'Speed', 'Endurance'], 'unknown'))
    }],
    [N.sensorRange, () => firstFailure(expectVerdicts(library, rebuilt(stock, 154192), ['SensorRange', 'SensorStrength', 'MSPReactor'], 'agree'), expectVerdicts(library, rebuilt(stock, 154883), ['SensorRange', 'SensorStrength', 'ThermalStrength'], 'agree'), expectVerdicts(library, rebuilt(older138, 154018), ['SensorRange'], 'agree'))],
    [N.emGeo, () => firstFailure(expectVerdicts(library, rebuilt(older138, 154018), ['EMStrength', 'MSPReactor', 'Size', 'Cost', 'Uridium', 'Boronide'], 'agree'), expectVerdicts(library, rebuilt(older138, 154016), ['Geostrength', 'MSPReactor', 'Size', 'Cost', 'Uridium', 'Boronide'], 'agree'))],
    [N.decoys, () => {
      const arrow = rebuilt(modded, 154261)
      const spear = rebuilt(modded, 154264)

      return firstFailure(expectNear('3 decoys size', arrow.ledger.decoys.msp, 1.5), expectNear('3 decoys Corbomite', arrow.ledger.decoys.minerals.Corbomite, 3), expectNear('1 decoy size', spear.ledger.decoys.msp, 0.5), expectVerdicts(library, arrow, ['MSPDecoys', 'Corbomite'], 'agree'))
    }],
    [N.recorded, () => firstFailure(expectVerdicts(library, rebuilt(modded, 500956), ['Level:emSensitivity', 'Level:laserFocus', 'Level:missileEcm'], 'unknown'), expectThat('a held level is reported', rebuilt(modded, 154261).comparisons.every((entry) => !entry.field.startsWith('Level:'))))],
    [N.everything, () => {
      const problems = fixtureProblems(library, data)

      return problems.length ? `${problems.length} problems, first ${problems.slice(0, 3).join('; ')}` : true
    }],
    [N.pinnedLoss, () => {
      const lost = new Map([...data].map(([label, fixture]) => [label, clone(fixture)]))

      designOf(lost.get('stock-271-g138'), 153989).row.MSPReactor = 0.0876

      return expectThat('a reactor figure moved off its stored value is not a problem', fixtureProblems(library, lost).length > 0)
    }],
    [N.engines, () => {
      const problems = []

      for (const fixture of data.values()) {
        for (const design of fixture.designs.filter((entry) => !entry.stageOnly && fixture.components[entry.row.EngineID])) {
          const engine = engineOf(fixture, design.row.EngineID)

          for (const entry of engine.comparisons.filter((comparisonOf) => library.judge(comparisonOf) !== 'agree')) {
            problems.push(`${fixture.label} ${engine.id} ${entry.field} ${library.judge(entry)}`)
          }
        }
      }

      return problems.length ? `${problems.length} engine figures do not agree, first ${problems.slice(0, 3).join('; ')}` : true
    }],
    [N.tolerance, () => firstFailure(expectThat('5e-10 apart is not in agreement', library.agrees(1, 1 + 5e-10)), expectThat('2e-9 apart is in agreement', !library.agrees(1, 1 + 2e-9)), expectThat('two zeros are not in agreement', library.agrees(0, 0)))],
    [N.noWarhead, () => firstFailure(expectVerdicts(library, rebuilt(stock, 154192), ['WarheadStrength', 'RadDamage', 'Tritanium'], 'agree'), expectNear('a 0.2 MSP sensor', library.missileSensorStrength({ sensorMsp: 0.2, sensorTech: 10 }), 0), expectNear('no warhead', library.missileWarheadStrength({ warheadMsp: 0, warheadTech: null }), 0))],
    [N.unresolved, () => {
      const { result } = edited(stock, 153728, (_fixture, design) => { design.row.WarheadStrength = 6.5; design.row.RadDamage = 6.5 })

      return firstFailure(expectThat('the warhead line is not unresolved', result.lines.warhead.state === 'unresolved'), expectVerdicts(library, result, ['WarheadStrength', 'Tritanium', 'Cost'], 'unknown'), expectVerdicts(library, result, ['Size', 'Speed'], 'agree'))
    }],
    [N.noStage, () => {
      const { result } = edited(stock, 154678, (fixture) => { fixture.designs = fixture.designs.filter((design) => design.id !== 154674) })

      return firstFailure(expectVerdicts(library, result, ['Size', 'Cost', 'FuelRequired', 'TotalFlightTime', 'Speed', 'MaxRange'], 'unknown'), expectVerdicts(library, result, ['WarheadStrength', 'RadDamage'], 'agree'))
    }],
    [N.engineMsp, () => {
      const { ledger } = rebuilt(modded, 154261)

      return firstFailure(expectNear('engine size', ledger.engine.msp, 6), expectNear('engine BP', ledger.engine.bp, 15), expectNear('engine Boronide', ledger.engine.minerals.Boronide, 7.5), expectNear('engine Gallicite', ledger.engine.minerals.Gallicite, 7.5))
    }],
    [N.known, () => {
      const entry = entryOf(rebuilt(modded, 500724), 'Cost')
      const verdictOf = (game, changed) => library.classify(KNOWN_MISSILE_ROWS, game, 500724, changed)
      const stored = verdictOf(140, { ...entry, stored: 999999 })
      const computed = verdictOf(140, { ...entry, computed: 1 })
      const near = verdictOf(140, { ...entry, stored: entry.stored * (1 + 1e-7) })

      return firstFailure(expectThat('the audited figures are not explained', Boolean(verdictOf(140, entry).reason)), expectThat('another stored figure is explained', stored.verdict === 'differ' && !stored.reason), expectThat('another computed figure is explained', computed.verdict === 'differ' && !computed.reason), expectThat('a stored figure moved by 1e-7 of itself is explained', near.verdict === 'differ' && !near.reason), expectThat('the audited figures of another game are explained', !verdictOf(999, entry).reason))
    }],
    [N.sizeRounding, () => {
      const { result } = edited(modded, 154261, (_fixture, design) => { design.row.MSPFuel += 1 })
      const entry = entryOf(result, 'Size')
      const rounded = entryOf(rebuilt(kristover, 154369), 'Size')

      return firstFailure(expectThat('an extra MSP of fuel is not a difference in size', Boolean(entry) && library.judge(entry) === 'differ'), expectThat('an extra MSP of fuel is explained as the size limit', !entry?.explain && !result.limited), expectThat('the rounding of the engine size is not explained', Boolean(rounded?.explain)))
    }],
    [N.lines, () => firstFailure(...[
      [modded, 154261, 83, 'eccm'],
      [modded, 154261, 275, 'terminal'],
      [modded, 154261, 274, 'laserEfficiency'],
      [modded, 154261, 41, 'reactor'],
      [stock, 153731, 276, 'retarget'],
      [stock, 153728, 12, 'warhead'],
      [stock, 153826, 19, 'thermal'],
      [modded, 154198, 281, 'shipDecoy'],
      [modded, 500726, 280, 'multipleWarheads'],
    ].map(([fixture, id, type, name]) => {
      const held = rebuilt(fixture, id)
      const { result } = edited(fixture, id, (copy, design) => { delete copy.races[design.race].held[type] })

      return firstFailure(expectThat(`${name} is reported unknown with its level held`, !entryOf(held, `Level:${name}`)), expectVerdicts(library, result, [`Level:${name}`], 'unknown'))
    }))],
    [N.basis, () => {
      const arrow = rebuilt(modded, 154261)
      const engine = engineOf(modded, 154262)
      const basisOf = (result, field) => entryOf(result, field)?.basis
      const resolved = ['WarheadStrength', 'LaserWarhead', 'MSPReactor'].filter((field) => basisOf(arrow, field) !== 'resolved-from-stored')
      const reproduced = ['Cost', 'Speed', 'Size'].filter((field) => basisOf(arrow, field) !== 'reproduced')

      return firstFailure(expectThat(`${resolved.join(', ')} not marked resolved from the stored figure`, resolved.length === 0), expectThat(`${reproduced.join(', ')} not marked reproduced`, reproduced.length === 0), expectThat('the sensor strength of a sensor is not marked resolved from the stored figure', basisOf(rebuilt(stock, 153826), 'ThermalStrength') === 'resolved-from-stored'), expectThat('the fuel use of an engine at the thrust of the design is not marked resolved from the stored figure', engine.comparisons.some((entry) => entry.field === 'FuelEfficiency' && entry.basis === 'resolved-from-stored')))
    }],
  ]
}

// The checks of the candidate evaluator (utilities/design-rules.js `evaluateMissile` and `admitMissiles`) over the fixtures `data`, run on `library`. The modded Arrow (154261) stands for a candidate whose every option is known, made from the options of a saved design.
const evaluatorChecks = (library, data) => {
  const { isAvailable, valueOrNull, getRule } = library.provenance
  const modded = data.get('modded-g140')
  const stock = data.get('stock-271-g138')
  const arrow = () => library.missileCandidateOf(modded, designOf(modded, 154261))
  const boxcar = () => library.missileCandidateOf(stock, designOf(stock, 154678))
  const without = (minerals, name) => Object.fromEntries(Object.entries(minerals).filter(([mineral]) => mineral !== name))
  const evaluate = (candidate, options) => library.evaluateMissile(candidate, options)
  const optionOf = (evaluation, id) => evaluation.options.find((option) => option.id === id)
  const effectOf = (evaluation, id) => evaluation.efficacy.effects.find((effect) => effect.id === id)
  const present = (value) => value !== null && value !== undefined
  const throws = (action) => {
    try {
      action()
    } catch {
      return true
    }

    return false
  }
  const mineralVector = (entry) => (entry.minerals !== null && library.MISSILE_MINERALS.every((name) => present(entry.minerals[name])) ? entry.minerals : null)
  const pair = (stored, result) => (present(stored) ? isAvailable(result) && near(result.value, stored) : !isAvailable(result))
  const unavailableTotals = (evaluation, names) => names.filter((name) => isAvailable(evaluation.totals[name]) || evaluation.totals[name].value !== null)

  return [
    [N.roundTrip, () => {
      const problems = []
      const counts = { feasible: 0, infeasible: 0, unknown: 0, unsupported: 0 }

      for (const fixture of data.values()) {
        for (const design of fixture.designs.filter((entry) => !entry.stageOnly)) {
          const result = library.reconcileMissile(fixture, design)
          const row = design.row
          const evaluation = evaluate(library.missileCandidateOf(fixture, design, { sizeLimit: result.limited ? row.Size : 0 }))
          const key = `${fixture.label} ${design.id}`

          counts[evaluation.verdict]++

          if (result.lines.warhead.state === 'unsupported') {
            if (evaluation.verdict !== 'unsupported') {
              problems.push(`${key} is ${evaluation.verdict}, not unsupported`)
            }

            continue
          }

          const lacking = library.CONTRIBUTIONS.filter((id) => !(present(result.ledger[id].msp) && present(result.ledger[id].bp) && mineralVector(result.ledger[id]) !== null))

          if (evaluation.verdict !== (lacking.length ? 'unknown' : 'feasible')) {
            problems.push(`${key} is ${evaluation.verdict} with ${lacking.length} unknown options`)
          }

          if (evaluation.unknown.map(({ option }) => option).join() !== lacking.join()) {
            problems.push(`${key} lists the unknown options ${evaluation.unknown.map(({ option }) => option).join()}, not ${lacking.join()}`)
          }

          for (const id of library.CONTRIBUTIONS) {
            const entry = result.ledger[id]
            const option = optionOf(evaluation, id)
            const vector = mineralVector(entry)
            const mineralsAgree = vector === null ? !isAvailable(option.minerals) : isAvailable(option.minerals) && library.MISSILE_MINERALS.every((name) => near(option.minerals.value[name], vector[name]))

            if (!pair(entry.msp, option.msp) || !pair(entry.bp, option.bp) || !mineralsAgree) {
              problems.push(`${key} ${id} does not carry its size, cost and minerals`)
            }
          }

          const everyKnown = (field) => library.CONTRIBUTIONS.every((id) => present(result.ledger[id][field]))

          if (isAvailable(evaluation.totals.sizeSum) !== everyKnown('msp') || isAvailable(evaluation.totals.cost) !== everyKnown('bp')) {
            problems.push(`${key} has a size or cost total that is not known exactly when its options are`)
          }

          if (lacking.length) {
            continue
          }

          const total = (field) => library.CONTRIBUTIONS.reduce((sum, id) => sum + optionOf(evaluation, id)[field].value, 0)
          const totals = evaluation.totals

          if (!near(totals.sizeSum.value, total('msp')) || !near(totals.cost.value, total('bp')) || library.MISSILE_MINERALS.some((name) => !near(totals.minerals[name].value, library.CONTRIBUTIONS.reduce((sum, id) => sum + optionOf(evaluation, id).minerals.value[name], 0)))) {
            problems.push(`${key} has totals that are not the sums of its options`)
          }

          if (!near(totals.size.value, result.figures.size) || !near(totals.cost.value, result.figures.cost)) {
            problems.push(`${key} has a size or cost that is not the rebuilt one`)
          }

          if (library.judge(entryOf(result, 'Cost')) === 'agree' && !library.agrees(row.Cost, totals.cost.value)) {
            problems.push(`${key} cost is ${totals.cost.value}, stored ${row.Cost}`)
          }

          if ((library.judge(entryOf(result, 'Size')) === 'agree' || result.limited) && !library.agrees(row.Size, totals.size.value)) {
            problems.push(`${key} size is ${totals.size.value}, stored ${row.Size}`)
          }

          for (const name of library.MISSILE_STORED_MINERALS.filter((mineral) => library.judge(entryOf(result, mineral)) === 'agree')) {
            if (!library.agrees(row[name], totals.minerals[name].value)) {
              problems.push(`${key} ${name} is ${totals.minerals[name].value}, stored ${row[name]}`)
            }
          }
        }
      }

      return firstFailure(problems.length ? `${problems.length} problems, first ${problems.slice(0, 3).join('; ')}` : true, expectThat('no design is feasible', counts.feasible > 0), expectThat('no design is unknown', counts.unknown > 0))
    }],
    [N.overBudget, () => {
      const base = evaluate(arrow())
      const { size, cost, minerals } = { size: base.totals.size.value, cost: base.totals.cost.value, minerals: base.totals.minerals }
      const mineral = library.MISSILE_MINERALS.find((name) => minerals[name].value > 0)
      const run = (budget, candidate = arrow()) => evaluate(candidate, { budget })
      const overSize = run({ maxMsp: size - 0.5 })
      const overCost = run({ maxBp: cost - 0.01 })
      const overMineral = run({ minerals: { [mineral]: minerals[mineral].value - 0.01 } })
      const capped = run({ maxMsp: 8 }, { ...arrow(), sizeLimit: 5 })
      const atLimits = run({ maxMsp: size, maxBp: cost, minerals: Object.fromEntries(library.MISSILE_MINERALS.map((name) => [name, minerals[name].value])) })
      const noise = run({ maxMsp: size * (1 - 1e-12), maxBp: cost * (1 - 1e-12) })
      const slightly = run({ maxBp: cost * (1 - 1e-6) })
      const violation = (evaluation, limit) => (isAvailable(evaluation.feasibility) ? evaluation.feasibility.value.violations.find((entry) => entry.limit === limit) : undefined)
      const { admitted, rejected } = library.admitMissiles([overSize, atLimits, overCost, overMineral, capped, base, noise, slightly])

      return firstFailure(
        expectThat('a candidate with every option known has no verdict', base.verdict === 'feasible' && isAvailable(base.feasibility) && base.feasibility.value.feasible === true),
        expectThat('a candidate over its size budget is not infeasible', overSize.verdict === 'infeasible' && Boolean(violation(overSize, 'size')) && near(violation(overSize, 'size').found, size) && near(violation(overSize, 'size').allowed, size - 0.5)),
        expectThat('a candidate over its cost budget is not infeasible', overCost.verdict === 'infeasible' && Boolean(violation(overCost, 'cost'))),
        expectThat(`a candidate over its ${mineral} budget is not infeasible`, overMineral.verdict === 'infeasible' && Boolean(violation(overMineral, mineral))),
        expectThat('a candidate whose options ask for more than its budget under a smaller size limit is not infeasible', capped.verdict === 'infeasible' && near(capped.totals.size.value, 5) && Boolean(violation(capped, 'size'))),
        expectThat('a candidate at its limits is not feasible', atLimits.verdict === 'feasible' && atLimits.feasibility.value.violations.length === 0),
        expectThat('a limit under the figure by float noise is not feasible', noise.verdict === 'feasible'),
        expectThat('a limit 1e-6 under the figure is not infeasible', slightly.verdict === 'infeasible'),
        expectThat('the evaluations admitted before ranking are not the feasible ones', admitted.length === 3 && admitted.includes(atLimits) && admitted.includes(base) && admitted.includes(noise) && rejected.length === 5),
        expectThat('a rejected evaluation does not say why', rejected.every((entry) => entry.verdict === 'infeasible' && entry.reasons.length > 0 && !admitted.includes(entry.evaluation)))
      )
    }],
    [N.unknownAccounting, () => {
      const generous = { maxMsp: 1000, maxBp: 1000000 }
      const tight = { maxMsp: 0.5, maxBp: 0.01 }
      const noWarheadTech = { ...arrow(), tech: { ...arrow().tech, warhead: null } }
      const noReactorTech = { ...arrow(), tech: { ...arrow().tech, reactor: null } }
      const noEngineTech = { ...arrow(), engine: { sizeMsp: 6, thrust: 2, engineTech: null, fuelTech: 1, maxThrust: 3 } }
      const noEngine = library.missileCandidateOf(stock, designOf(stock, 154110))
      const cases = [['warhead', noWarheadTech], ['reactor', noReactorTech], ['engine', noEngineTech], ['engine', noEngine]]
      const problems = cases.flatMap(([id, candidate], index) => [generous, tight].map((budget) => {
        const evaluation = evaluate(candidate, { budget })
        const option = optionOf(evaluation, id)

        return firstFailure(
          expectThat(`case ${index} is ${evaluation.verdict}, not unknown`, evaluation.verdict === 'unknown'),
          expectThat(`case ${index} has a feasibility`, !isAvailable(evaluation.feasibility) && evaluation.feasibility.value === null && evaluation.feasibility.inputs.missing.length > 0),
          expectThat(`case ${index} lists no unknown option`, evaluation.unknown.some((entry) => entry.option === id && entry.reason.length > 0) && option.status === 'unknown' && option.reasons.length > 0),
          expectThat(`case ${index} has a total of 0 where its options are not known`, ['sizeSum', 'size', 'cost'].some((name) => !isAvailable(evaluation.totals[name])) && ['sizeSum', 'size', 'cost'].every((name) => isAvailable(evaluation.totals[name]) || evaluation.totals[name].value === null)),
          expectThat(`case ${index} is admitted`, library.admitMissiles([evaluation]).admitted.length === 0 && library.admitMissiles([evaluation]).rejected[0].verdict === 'unknown')
        )
      }))
      const warhead = optionOf(evaluate(noWarheadTech), 'warhead')
      const engine = optionOf(evaluate(noEngineTech), 'engine')
      const designed = evaluate({ ...arrow(), engine: { sizeMsp: 6, thrust: 2, engineTech: 10, fuelTech: 1, maxThrust: 3 } }, { budget: generous })
      const expected = library.missileEngineDesign({ sizeMsp: 6, thrust: 2, engineTech: 10, fuelTech: 1, maxThrust: 3 })

      return firstFailure(
        ...problems,
        expectThat('a warhead with no tech has no cost or its size is lost', isAvailable(warhead.msp) && !isAvailable(warhead.bp) && !isAvailable(warhead.minerals)),
        expectThat('an engine with no tech has a cost, or its size is lost', isAvailable(engine.msp) && near(engine.msp.value, 6) && !isAvailable(engine.bp) && engine.reasons.join().includes('engineTech')),
        expectThat('the speed of an engine with no tech is not unavailable', !isAvailable(evaluate(noEngineTech).figures.speed) && evaluate(noEngineTech).figures.speed.value === null),
        expectThat('an engine designed from its techs is not feasible', designed.verdict === 'feasible' && near(optionOf(designed, 'engine').bp.value, library.roundHalfEven(expected.cost, 4)) && near(optionOf(designed, 'engine').msp.value, 6))
      )
    }],
    [N.unsupportedOptions, () => {
      const generous = { maxMsp: 1000, maxBp: 1000000 }
      const base = arrow()
      const pod = evaluate({ ...base, groundPod: true }, { budget: generous })
      const radiation = evaluate({ ...base, enhancedRadiation: true }, { budget: generous })
      const retargetTwo = evaluate({ ...base, options: { ...base.options, retarget: 2 } }, { budget: generous })
      const retargetOne = evaluate({ ...base, options: { ...base.options, retarget: 1 } }, { budget: generous })
      const refused = [pod, radiation, retargetTwo]

      return firstFailure(
        expectThat('a ground pod is not unsupported in every option', pod.verdict === 'unsupported' && pod.options.every((option) => option.status === 'unsupported') && pod.unsupported.length === library.CONTRIBUTIONS.length && pod.unsupported[0].reason.includes('ground pod')),
        expectThat('an enhanced radiation warhead is not unsupported in its cost alone', radiation.verdict === 'unsupported' && optionOf(radiation, 'warhead').status === 'unsupported' && isAvailable(optionOf(radiation, 'warhead').msp) && !isAvailable(optionOf(radiation, 'warhead').bp) && radiation.options.filter((option) => option.id !== 'warhead').every((option) => option.status === 'known') && !isAvailable(radiation.figures.warheadStrength) && isAvailable(radiation.totals.size) && !isAvailable(radiation.totals.cost)),
        expectThat('a retargeting level above 1 is not unsupported in its size and cost', retargetTwo.verdict === 'unsupported' && optionOf(retargetTwo, 'retarget').status === 'unsupported' && !isAvailable(optionOf(retargetTwo, 'retarget').msp) && !isAvailable(retargetTwo.totals.size) && retargetTwo.options.filter((option) => option.id !== 'retarget').every((option) => option.status === 'known')),
        expectThat('a retargeting level 1 is not feasible with its 0.5 MSP and 0.5 Uridium', retargetOne.verdict === 'feasible' && near(optionOf(retargetOne, 'retarget').msp.value, 0.5) && near(optionOf(retargetOne, 'retarget').bp.value, 0.5) && near(optionOf(retargetOne, 'retarget').minerals.value.Uridium, 0.5)),
        expectThat('an unsupported candidate has a feasibility, a total of 0 or is admitted', refused.every((evaluation) => !isAvailable(evaluation.feasibility) && evaluation.totals.cost.value === null && library.admitMissiles([evaluation]).admitted.length === 0 && library.admitMissiles([evaluation]).rejected[0].verdict === 'unsupported' && unavailableTotals(evaluation, ['cost']).length === 0))
      )
    }],
    [N.efficacy, () => {
      const candidate = { ...arrow(), warheads: 2, options: { ...arrow().options, retarget: 1 } }
      const scenario = { targetSpeed: 3000, jammer: 2, modifier: 1, version: '2.7.1' }
      const evaluation = evaluate(candidate, { budget: { maxMsp: 1000, maxBp: 1000000 }, scenario })
      const plain = evaluate(candidate)
      const speed = valueOrNull(evaluation.figures.speed)
      const hitRules = [['eccmHit', library.hit.HIT_RULES.jammer], ['terminalHit', library.hit.HIT_RULES.raw], ['warheadHits', library.hit.HIT_RULES.hits]]
      const raw = valueOrNull(library.hit.rawHitChance({ missileSpeed: speed, targetSpeed: scenario.targetSpeed, atg: candidate.options.terminal, modifier: scenario.modifier, jammer: scenario.jammer, eccm: candidate.options.eccm, version: scenario.version }))
      const hitProblems = hitRules.map(([id, rule]) => {
        const effect = effectOf(evaluation, id)
        const confirmed = getRule(rule).verification === 'confirmed'

        return effect ? firstFailure(expectThat(`${id} is verified ${effect.verified}, its rule is ${getRule(rule).verification}`, effect.rule === rule && effect.verified === confirmed), expectThat(`${id} is counted ${effect.counted}`, effect.counted === (confirmed && effect.value !== null)), expectThat(`${id} is not excluded with a reason`, effect.counted || ((effect.reason || '').length > 0 && evaluation.efficacy.excluded.some((entry) => entry.id === id))), expectThat(`${id} has no reason to be unverified`, confirmed || effect.reason.includes('not confirmed'))) : `${id} is not among the effects`
      })
      const payload = ['warheadStrength', 'speed', 'endurance', 'maxRange'].map((id) => effectOf(evaluation, id))
      const retargeting = effectOf(evaluation, 'retargeting')
      const effects = [
        { id: 'confirmedValue', option: 'warhead', label: 'a confirmed value', units: '', rule: 'design.missileAccounting', applies: () => true, read: () => ({ value: 7, reason: null }) },
        { id: 'confirmedMissing', option: 'warhead', label: 'a confirmed value that is not known', units: '', rule: 'design.missileAccounting', applies: () => true, read: () => ({ value: null, reason: 'an input is missing' }) },
        { id: 'estimatedValue', option: 'warhead', label: 'an estimated value', units: '', rule: 'design.missileAccountingExtended', applies: () => true, read: () => ({ value: 9, reason: null }) },
      ]

      const injected = evaluate(arrow(), { effects })

      return firstFailure(
        ...hitProblems,
        expectThat('a validated candidate with a targeting effect that is not verified cannot be designed', evaluation.verdict === 'feasible' && isAvailable(evaluation.feasibility)),
        expectThat('the payload figures are not verified and counted', payload.every((effect) => Boolean(effect) && effect.verified && effect.counted && effect.value !== null && effect.rule === 'design.missileAccounting')),
        expectThat('the speed counted is not the speed of the candidate', near(effectOf(evaluation, 'speed').value, speed)),
        expectThat('the terminal guidance hit chance is not the raw chance of the missile hit rules', near(effectOf(evaluation, 'terminalHit').value, raw)),
        expectThat('retargeting with no rule is counted or has no reason', Boolean(retargeting) && retargeting.rule === null && !retargeting.verified && !retargeting.counted && retargeting.reason === 'no rule models this effect'),
        expectThat('an effect that is not counted is not excluded', evaluation.efficacy.effects.filter((effect) => !effect.counted).every((effect) => evaluation.efficacy.excluded.some((entry) => entry.id === effect.id)) && evaluation.efficacy.counted.length === evaluation.efficacy.effects.filter((effect) => effect.counted).length),
        expectThat('a candidate has a score of its own', !('score' in evaluation) && !('score' in evaluation.efficacy) && evaluation.efficacy.counted.every((entry) => Object.keys(entry).sort().join() === 'id,units,value')),
        expectThat('a hit effect is worked out with no scenario', plain.efficacy.scenario === null && ['eccmHit', 'terminalHit', 'warheadHits'].every((id) => !effectOf(plain, id))),
        expectThat('an effect of a confirmed rule is not counted, or one of an estimated rule is', injected.efficacy.counted.length === 1 && injected.efficacy.counted[0].id === 'confirmedValue' && injected.efficacy.counted[0].value === 7),
        expectThat('an effect of a confirmed rule with no value is not excluded with its reason', injected.efficacy.excluded.some((entry) => entry.id === 'confirmedMissing' && entry.reason === 'an input is missing')),
        expectThat('an effect of an estimated rule is not excluded as not confirmed', injected.efficacy.excluded.some((entry) => entry.id === 'estimatedValue' && entry.reason.includes('estimated')))
      )
    }],
    [N.validation, () => {
      const base = arrow()
      const invalid = [
        ['a negative fuel size', () => evaluate({ ...base, fuelMsp: -1 })],
        ['a fraction of an engine', () => evaluate({ ...base, engines: 1.5 })],
        ['a size that is not a number', () => evaluate({ ...base, warheadMsp: Number.NaN })],
        ['a field the candidate does not have', () => evaluate({ ...base, colour: 'red' })],
        ['an option the candidate does not have', () => evaluate({ ...base, options: { ...base.options, speed: 1 } })],
        ['a tech given as text', () => evaluate({ ...base, tech: { ...base.tech, warhead: '4' } })],
        ['no candidate', () => evaluate(null)],
        ['a negative size limit of the budget', () => evaluate(base, { budget: { maxMsp: -1 } })],
        ['a budget field that does not exist', () => evaluate(base, { budget: { maxCost: 5 } })],
        ['a mineral that does not exist', () => evaluate(base, { budget: { minerals: { Unobtainium: 1 } } })],
        ['a cost limit given as text', () => evaluate(base, { budget: { maxBp: '10' } })],
        ['a stage with no Uridium given', () => evaluate({ ...boxcar(), stage: { ...boxcar().stage, minerals: without(boxcar().stage.minerals, 'Uridium') } })],
        ['a stage with no minerals given', () => evaluate({ ...boxcar(), stage: { ...boxcar().stage, minerals: {} } })],
        ['a stage mineral that is not a number', () => evaluate({ ...boxcar(), stage: { ...boxcar().stage, minerals: { ...boxcar().stage.minerals, Uridium: null } } })],
        ['an engine counted with no engine', () => evaluate({ ...base, engine: null, engines: 1 })],
        ['two engines counted with no engine', () => evaluate({ ...base, engine: undefined, engines: 2 })],
        ['a stage counted with no stage', () => evaluate({ ...boxcar(), stage: null, stages: 9 })],
      ]
      const accepted = invalid.filter(([, action]) => !throws(action)).map(([what]) => what)
      const zero = evaluate(base, { budget: { maxMsp: 0 } })

      return firstFailure(
        expectThat(`${accepted.join(', ')} not refused`, accepted.length === 0),
        expectThat('a tech that is not known is refused', !throws(() => evaluate({ ...base, tech: { ...base.tech, warhead: null } }))),
        expectThat('a count of 0 with no part is refused', !throws(() => evaluate({ ...base, engine: null, engines: 0 })) && !throws(() => evaluate({ ...boxcar(), stage: null, stages: 0 }))),
        expectThat('an engine-less saved design is counted with no engine', library.missileCandidateOf(modded, designOf(modded, 154198)).engines === 0 && evaluate(library.missileCandidateOf(modded, designOf(modded, 154198))).verdict !== undefined),
        expectThat('a stage with its minerals given is refused', !throws(() => evaluate(boxcar()))),
        expectThat('a limit of 0 is not a limit', zero.verdict === 'infeasible')
      )
    }],
    [N.registered, () => {
      const wanted = [['design.missileEngineDesign', 'confirmed'], ['design.missileAccounting', 'confirmed'], ['design.missileAccountingExtended', 'estimated'], ['design.missileFeasibility', 'confirmed'], ['design.missileEfficacy', 'assumed'], ['design.missileLevels', 'estimated']]
      const wrong = wanted.filter(([id, status]) => getRule(id)?.verification !== status).map(([id, status]) => `${id} is ${getRule(id)?.verification ?? 'not registered'}, expected ${status}`)

      return wrong.length ? wrong.join('; ') : true
    }],
    [N.provenance, () => {
      const costFields = ['Cost', 'Corbomite', 'Tritanium', 'Boronide', 'Uridium', 'Gallicite', 'UnstoredMinerals']
      const domain = library.MISSILE_COST_DOMAIN
      const quantities = Object.keys(domain)
      const observed = Object.fromEntries(quantities.map((name) => [name, 0]))

      for (const fixture of data.values()) {
        for (const design of fixture.designs.filter((entry) => !entry.stageOnly)) {
          const result = library.reconcileMissile(fixture, design)

          if (costFields.every((field) => entryOf(result, field) && library.judge(entryOf(result, field)) === 'agree')) {
            const found = library.missileCostQuantities(library.missileCandidateOf(fixture, design))

            for (const name of quantities) {
              observed[name] = Math.max(observed[name], found[name] ?? 0)
            }
          }
        }
      }

      const mjolnirCandidate = library.missileCandidateOf(modded, designOf(modded, 500724))
      const mjolnir = evaluate(mjolnirCandidate, { budget: { maxBp: 300 } })
      const mjolnirSized = evaluate(mjolnirCandidate, { budget: { maxMsp: 1000 } })
      const base = arrow()
      const inside = evaluate(base, { budget: { maxMsp: 1000, maxBp: 1000000 } })
      const staged = evaluate(boxcar(), { budget: { maxBp: 1000000 } })
      const withBudget = (candidate) => evaluate(candidate, { budget: { maxBp: 1000 } })
      const sameTechs = (candidate) => Object.keys(base.tech).every((line) => candidate.tech[line] === base.tech[line])
      const thermalSize = 150 / (base.tech.thermal * 0.05)
      const sameStrength = withBudget({ ...base, thermalMsp: thermalSize })
      const nextLevel = withBudget({ ...base, tech: { ...base.tech, thermal: base.tech.thermal + 1 } })
      const damageAtBound = withBudget({ ...base, warheadMsp: domain.warheadDamage / base.tech.warhead })
      const damageOver = withBudget({ ...base, warheadMsp: (domain.warheadDamage + 0.5) / base.tech.warhead })
      const statusOf = (result) => (result ? result.status : 'no result')
      const ruleOf = (result) => (result ? result.rule.id : 'no result')
      const costOf = (evaluation) => [evaluation.totals.cost, ...library.MISSILE_MINERALS.map((name) => evaluation.totals.minerals[name]), ...evaluation.options.flatMap((option) => [option.bp, option.minerals])]
      const estimated = (evaluation) => costOf(evaluation).every((result) => statusOf(result) === 'estimated' && ruleOf(result) === 'design.missileAccountingExtended') && statusOf(evaluation.feasibility) === 'estimated'
      const confirmed = (evaluation) => [...costOf(evaluation), evaluation.feasibility].every((result) => statusOf(result) === 'confirmed')
      const named = (evaluation, text) => evaluation.totals.cost.assumptions.some((entry) => entry.includes(text))
      const flight = ['endurance', 'maxRange', 'totalFlightTime']
      const counted = (evaluation, id) => evaluation.efficacy.counted.some((entry) => entry.id === id)

      return firstFailure(
        expectThat(`the cost domain is ${JSON.stringify(domain)}, the highest of the designs whose cost reproduces is ${JSON.stringify(observed)}`, quantities.every((name) => domain[name] === observed[name])),
        expectThat('a design beyond the domain has unknown or unsupported options', mjolnir.unknown.length === 0 && mjolnir.unsupported.length === 0),
        expectThat('the cost and minerals beyond the domain are not estimated by the extended rule', estimated(mjolnir)),
        expectThat('the size beyond the domain is not confirmed', [mjolnir.totals.size, mjolnir.totals.sizeSum, ...mjolnir.options.map((option) => option.msp)].every((result) => statusOf(result) === 'confirmed' && ruleOf(result) === 'design.missileAccounting')),
        expectThat('the quantities beyond the domain are not all named', ['thermal sensor strength 150', 'sensor reactor output 30', 'laser efficiency 90'].every((text) => named(mjolnir, text))),
        expectThat(`the verdict on a cost beyond the domain is ${mjolnir.verdict} at ${statusOf(mjolnir.feasibility)}`, mjolnir.verdict === 'infeasible' && statusOf(mjolnir.feasibility) === 'estimated' && ruleOf(mjolnir.feasibility) === 'design.missileFeasibility'),
        expectThat(`the verdict on a size of a design beyond the domain is ${statusOf(mjolnirSized.feasibility)}, not confirmed`, mjolnirSized.verdict === 'feasible' && statusOf(mjolnirSized.feasibility) === 'confirmed'),
        expectThat('a design at the highest figures of the domain is not confirmed', confirmed(inside) && inside.options.every((option) => statusOf(option.msp) === 'confirmed')),
        expectThat(`a thermal sensor of the same strength as design 500724 with a tech level within the domain is ${statusOf(sameStrength.totals.cost)}, not estimated`, sameTechs(sameStrength.candidate) && near(valueOrNull(sameStrength.figures.sensorStrengths.thermal), 150) && estimated(sameStrength) && named(sameStrength, 'thermal sensor strength 150')),
        expectThat(`a thermal sensor one tech level up at the size of the domain is ${statusOf(nextLevel.totals.cost)}, not estimated`, near(valueOrNull(nextLevel.figures.sensorStrengths.thermal), 0.19) && estimated(nextLevel) && named(nextLevel, 'thermal sensor strength 0.19') && !named(nextLevel, 'thermal sensor size')),
        expectThat('a warhead at the damage of the domain is not confirmed', confirmed(damageAtBound) && damageAtBound.candidate.warheadMsp < domain.warheadMsp),
        expectThat('a warhead over the damage of the domain, with a size and a tech within it, is not estimated', estimated(damageOver) && named(damageOver, 'warhead damage') && !named(damageOver, 'warhead size') && damageOver.candidate.warheadMsp < domain.warheadMsp),
        expectThat('a design with second stages has a flight time or an endurance that is confirmed', flight.every((name) => statusOf(staged.figures[name]) === 'estimated' && ruleOf(staged.figures[name]) === 'design.missileAccountingExtended' && isAvailable(staged.figures[name]))),
        expectThat('the speed, fuel, size or cost of a design with second stages is not confirmed', [staged.figures.speed, staged.figures.fuelRequired, staged.totals.size].every((result) => statusOf(result) === 'confirmed') && confirmed(staged)),
        expectThat('an estimated endurance or range is counted', !counted(staged, 'endurance') && !counted(staged, 'maxRange') && counted(staged, 'speed')),
        expectThat('an estimated endurance is not excluded with its reason', staged.efficacy.excluded.some((entry) => entry.id === 'endurance' && entry.reason.includes('estimated') && entry.reason.includes('154678'))),
        expectThat('the flight figures of a design with no second stage are not confirmed', flight.every((name) => statusOf(inside.figures[name]) === 'confirmed') && counted(inside, 'endurance') && counted(inside, 'maxRange'))
      )
    }],
    [N.mounting, () => {
      const tech = arrow().tech
      const rowOf = (fixture, id) => ({ ...designOf(fixture, id).row })
      const arrowRow = rowOf(modded, 154261)
      const decoyRow = rowOf(modded, 154198)
      const boxcarRow = rowOf(stock, 154678)
      const project = (row, parts) => library.savedMissileCandidate(row, { tech, ...parts })
      const budget = { maxMsp: 1000, maxBp: 10 }
      const noEngine = project(arrowRow, { engine: null, stage: null })
      const undefinedEngine = project(arrowRow, { stage: null })
      const noStage = library.savedMissileCandidate(boxcarRow, { engine: library.missileEngineOf(stock, boxcarRow), stage: null, tech: boxcar().tech })
      const noSize = project({ ...arrowRow, MSPEngine: 0, Speed: 0 }, { engine: null, stage: null })
      const none = project(decoyRow, { engine: null, stage: null })
      const evaluated = [noEngine, undefinedEngine, noStage, noSize].map((candidate) => evaluate(candidate, { budget }))

      return firstFailure(
        expectThat('the row of the Arrow, given no record of its engine, counts no engine', noEngine.engines === 1 && Boolean(noEngine.engine) && noEngine.engine.missing === true && noEngine.engine.storedMsp === 6 && undefinedEngine.engines === 1 && undefinedEngine.engine.missing === true),
        expectThat('a row that shows a part mounted, given no record of it, is feasible or confirmed', evaluated.every((evaluation) => evaluation.verdict === 'unknown' && !isAvailable(evaluation.feasibility) && library.admitMissiles([evaluation]).admitted.length === 0)),
        expectThat('the engine of a row given no record is given a cost', !isAvailable(optionOf(evaluated[0], 'engine').bp) && !isAvailable(evaluated[0].totals.cost)),
        expectThat('the row of the Sticky Bomb, given no record of its second stages, counts none', noStage.stages === 9 && noStage.stage.missing === true && optionOf(evaluated[2], 'secondStage').status === 'unknown'),
        expectThat('an engine whose size the row does not store is given a size', noSize.engine.missing === true && noSize.engine.storedMsp === null && !isAvailable(optionOf(evaluated[3], 'engine').msp)),
        expectThat('a design with no engine mounted is not counted 0 engines', none.engine === null && none.engines === 0),
        expectThat('an engine given for a row that shows none mounted is not refused', throws(() => project(decoyRow, { engine: library.missileEngineOf(modded, arrowRow), stage: null }))),
        expectThat('a second stage given for a row that shows none mounted is not refused', throws(() => project(arrowRow, { engine: library.missileEngineOf(modded, arrowRow), stage: noStage.stage }))),
        expectThat('a row that shows an engine mounted and counts none is not refused', throws(() => project({ ...arrowRow, NumEngines: 0 }, { engine: null, stage: null }))),
        expectThat('a row that shows a second stage mounted and counts none is not refused', throws(() => library.savedMissileCandidate({ ...boxcarRow, NumSS: 0 }, { engine: library.missileEngineOf(stock, boxcarRow), stage: null, tech: boxcar().tech })))
      )
    }],
  ]
}

const missileChecks = (library, data) => [...reconciliationChecks(library, data), ...evaluatorChecks(library, data)]

// A planted fault: `find` (text found once in design-rules.js, design-data.js or missile-reconcile.js) becomes `replace` in a copy of them, and every check named in `fails` must then fail.
const MISSILE_MUTANTS = [
  { name: 'the ECCM add-on given no size', find: 'export const ECCM_MSP = 0.25', replace: 'export const ECCM_MSP = 0', fails: [N.twelve, N.addOns] },
  { name: 'the terminal guidance add-on given no size', find: 'export const TERMINAL_GUIDANCE_MSP = 0.25', replace: 'export const TERMINAL_GUIDANCE_MSP = 0', fails: [N.twelve, N.addOns] },
  { name: 'the laser warhead add-on given no size', find: 'export const LASER_WARHEAD_MSP = 0.25', replace: 'export const LASER_WARHEAD_MSP = 0', fails: [N.twelve, N.addOns] },
  { name: 'the terminal guidance cost not the multiplier less 1', find: '{ Uridium: options.terminal - 1 }', replace: '{ Uridium: options.terminal }', fails: [N.addOns] },
  { name: 'the ECCM cost twice its share', find: 'export const ECCM_BP_DIVISOR = 20', replace: 'export const ECCM_BP_DIVISOR = 10', fails: [N.addOns] },
  { name: 'the Corundium of the laser left out of its cost', find: '{ Corundium: tech.laserEfficiency / 100 }', replace: '{}', fails: [N.corundium] },
  { name: 'retargeting costed at every level', find: 'options.retarget === 1 ? 0.5 : 0, { Uridium: options.retarget === 1 ? 0.5 : 0 }', replace: 'options.retarget > 0 ? 0.5 : 0, { Uridium: options.retarget > 0 ? 0.5 : 0 }', fails: [N.retargeting] },
  { name: 'retargeting given half its size', find: 'export const RETARGETING_MSP = 0.5', replace: 'export const RETARGETING_MSP = 0.25', fails: [N.retargeting] },
  { name: 'the level the race holds now taken for the level of the design', find: 'lines[name] = level ? line(LINE_STATE.RESOLVED, level, null,', replace: 'lines[name] = level ? line(LINE_STATE.RESOLVED, current, null,', fails: [N.historical] },
  { name: 'a level the race has passed not marked', find: 'historical: current !== null && current.id !== level.id && current.info !== level.info', replace: 'historical: false', fails: [N.historical] },
  { name: 'the reactor given no cost', find: 'export const REACTOR_BP_PER_OUTPUT = 3', replace: 'export const REACTOR_BP_PER_OUTPUT = 0', fails: [N.reactor, N.twelve] },
  { name: 'the reactor sized without the 0.05 of the power plant tech', find: 'roundHalfEven(output / (reactorTech * SENSOR_STRENGTH_FACTOR), 4)', replace: 'roundHalfEven(output / reactorTech, 4)', fails: [N.reactor] },
  { name: 'a power plant tech that is not known read as 0 MSP', find: 'return isKnown(reactorTech) && reactorTech > 0 ? roundHalfEven(output / (reactorTech * SENSOR_STRENGTH_FACTOR), 4) : null', replace: 'return isKnown(reactorTech) && reactorTech > 0 ? roundHalfEven(output / (reactorTech * SENSOR_STRENGTH_FACTOR), 4) : 0', fails: [N.noReactor] },
  { name: 'a midpoint rounded away from 0', find: 'if (Math.abs(scaled - floor - 0.5) < 1e-9) {', replace: 'if (false) {', fails: [N.rounding] },
  { name: 'the thrust above the greatest modifier not boosted', find: 'const boost = thrust > maxThrust ? (thrust - maxThrust) / maxThrust * THRUST_BOOST_SLOPE + 1 : 1', replace: 'const boost = 1', fails: [N.thrust, N.settledThrust, N.engines] },
  { name: 'the speed not capped', find: 'Math.min(MAX_MISSILE_SPEED, roundHalfEven(enginePower / (size / MSP_PER_HS) * 1000, 1))', replace: 'roundHalfEven(enginePower / (size / MSP_PER_HS) * 1000, 1)', fails: [N.capAndFloor] },
  { name: 'the size not floored at 1', find: '} else if (size < MIN_MISSILE_SIZE) {', replace: '} else if (false) {', fails: [N.capAndFloor] },
  { name: 'the endurance rounded to 2 decimals', find: 'roundHalfEven(ownFuel / (enginePower * engine.fuelEfficiency) * 3600, 1)', replace: 'roundHalfEven(ownFuel / (enginePower * engine.fuelEfficiency) * 3600, 2)', fails: [N.stockArrow, N.fuel] },
  { name: 'the fuel rounded to a litre instead of cut', find: 'const floorExact = (value) => Math.floor(value + 1e-9)', replace: 'const floorExact = (value) => Math.round(value)', fails: [N.fuel] },
  { name: 'a ship decoy not given 5 MSP at least', find: 'if (shipDecoy && size < MIN_SHIP_DECOY_SIZE) {', replace: 'if (false) {', fails: [N.decoy] },
  { name: 'a ship decoy costed at 1 BP a MSP', find: 'export const SHIP_DECOY_BP_PER_MSP = 4', replace: 'export const SHIP_DECOY_BP_PER_MSP = 1', fails: [N.decoy] },
  { name: 'a ship decoy given 100 strength a MSP', find: 'export const SHIP_DECOY_STRENGTH_PER_MSP = 200', replace: 'export const SHIP_DECOY_STRENGTH_PER_MSP = 100', fails: [N.decoy] },
  { name: 'a warhead after the first given no size', find: 'export const EXTRA_WARHEAD_MSP = 0.1', replace: 'export const EXTRA_WARHEAD_MSP = 0', fails: [N.extraWarhead] },
  { name: 'a second stage counted once whatever their number', find: 'contribution(stage.size * stages, stage.cost * stages,', replace: 'contribution(stage.size, stage.cost * stages,', fails: [N.stage] },
  { name: 'the fuel of the second stages left out', find: 'ownFuel + (stage && stages > 0 ? stage.fuelRequired * stages : 0)', replace: 'ownFuel', fails: [N.stage] },
  { name: 'a second stage the save lacks counted as nothing', find: 'contributions.secondStage = contribution(null, null, null, stage.reason || STAGE_MISSING)', replace: 'contributions.secondStage = contribution(0, 0, {})', fails: [N.noStage] },
  { name: 'a case the rules do not cover counted as agreement', find: "if (comparison.unsupported) {\n      return 'unsupported'", replace: "if (comparison.unsupported) {\n      return 'agree'", fails: [N.unsupported] },
  { name: 'a figure the rules cannot give read as 0', find: 'computed: isKnown(computed) ? computed : null, kind', replace: 'computed: isKnown(computed) ? computed : 0, kind', fails: [N.noReactor, N.noEngine, N.noStage, N.unresolved] },
  { name: 'a figure the save does not store read as 0', find: 'stored: isKnown(stored) ? stored : null,', replace: 'stored: isKnown(stored) ? stored : 0,', fails: [N.nullMineral] },
  { name: 'a size limit taken as the cause of an oversize without the speed', find: ' && isKnown(capped.figures.speed) && agrees(row.Speed, capped.figures.speed)', replace: '', fails: [N.sizeLimit] },
  { name: 'a size limit taken as the cause of any oversize', find: 'Math.abs(excess - engineRounding) <= 1e-9', replace: 'true', fails: [N.sizeRounding] },
  { name: 'a pinned difference explained at any figures', find: 'pinned(candidate.stored, entry.stored) && pinned(candidate.computed, entry.computed)', replace: 'true', fails: [N.known] },
  { name: 'a pinned difference explained in any game', find: 'candidate.game === game && ', replace: '', fails: [N.known] },
  { name: 'a pinned difference explained at 1e-6 of its figures', find: 'const pinned = (audited, found) => agrees(audited, found)', replace: 'const pinned = (audited, found) => Math.abs(audited - found) <= 1e-9 + 1e-6 * Math.max(Math.abs(audited), Math.abs(found))', fails: [N.known] },
  { name: 'a resolved level not marked as resolved from the stored figure', find: "RESOLVED: 'resolved-from-stored'", replace: "RESOLVED: 'reproduced'", fails: [N.basis] },
  { name: 'an engine the save lacks costed at 0 BP', find: 'contribution(engine.storedMsp, null, { Boronide: null, Gallicite: null }, engine.reason || ENGINE_MISSING)', replace: 'contribution(engine.storedMsp, 0, { Boronide: 0, Gallicite: 0 }, engine.reason || ENGINE_MISSING)', fails: [N.noEngine] },
  { name: 'the engine cost not shared between Boronide and Gallicite', find: '{ Boronide: engineBp / 2, Gallicite: engineBp / 2 }', replace: '{ Boronide: engineBp, Gallicite: 0 }', fails: [N.engineMsp, N.twelve] },
  { name: 'the resolution of a sensor to the power 1/3', find: 'resolution ** (2 / 3)', replace: 'resolution ** (1 / 3)', fails: [N.sensorRange] },
  { name: 'the EM sensor given the strength of the thermal one', find: "sensorContribution('em', emMsp, strengths[2])", replace: "sensorContribution('em', emMsp, strengths[1])", fails: [N.emGeo] },
  { name: 'a decoy given 1 MSP', find: 'export const DECOY_MSP = 0.5', replace: 'export const DECOY_MSP = 1', fails: [N.decoys] },
  { name: 'the tolerance of 1e-6', find: 'export const REPRODUCTION_TOLERANCE = 1e-9', replace: 'export const REPRODUCTION_TOLERANCE = 1e-6', fails: [N.tolerance] },
  { name: 'a design with no warhead given an unknown strength', find: 'export const missileWarheadStrength = ({ warheadMsp, warheadTech, radiationMultiplier = 1, shipDecoy = false }) => {\n  if (!(warheadMsp > 0)) {', replace: 'export const missileWarheadStrength = ({ warheadMsp, warheadTech, radiationMultiplier = 1, shipDecoy = false }) => {\n  if (false) {', fails: [N.noWarhead] },
  { name: 'a stored figure no held level gives taken from the level held now', find: ': line(LINE_STATE.UNRESOLVED, null, why, { matches: [], current })', replace: ': line(LINE_STATE.RESOLVED, current, null, { matches: [], current })', fails: [N.unresolved] },
  { name: 'a level the race does not hold not reported', find: '      if (entry.state === LINE_STATE.UNRESOLVED) {', replace: '      if (false) {', fails: [N.recorded, N.lines] },
  { name: 'only the recorded levels reported when the race does not hold them', find: '      if (entry.state === LINE_STATE.UNRESOLVED) {', replace: "      if (entry.state === LINE_STATE.UNRESOLVED && ['emSensitivity', 'laserFocus', 'missileEcm'].includes(name)) {", fails: [N.lines] },
  { name: 'the Tritanium and cost of a warhead half its damage', find: 'export const WARHEAD_BP_DIVISOR = 4', replace: 'export const WARHEAD_BP_DIVISOR = 2', fails: [N.historical, N.twelve] },
  { name: 'the fuel given no size', find: 'contributions.fuel = contribution(fuelMsp, 0, {})', replace: 'contributions.fuel = contribution(0, 0, {})', fails: [N.twelve, N.stockArrow] },
  { name: 'a candidate over a limit never infeasible', find: 'const over = (found, allowed) => found > allowed && !agrees(found, allowed)', replace: 'const over = () => false', fails: [N.overBudget] },
  { name: 'a limit compared without the tolerance of the figures', find: 'const over = (found, allowed) => found > allowed && !agrees(found, allowed)', replace: 'const over = (found, allowed) => found > allowed', fails: [N.overBudget] },
  { name: 'the size compared without what the options ask for', find: 'Math.max(totals.size.value, totals.sizeSum.value)', replace: 'totals.size.value', fails: [N.overBudget] },
  { name: 'the cost limit never compared', find: "['cost', limits.maxBp, totals.cost.value]", replace: "['cost', null, totals.cost.value]", fails: [N.overBudget] },
  { name: 'the mineral limits never compared', find: ', ...Object.entries(limits.minerals).map(([name, allowed]) => [name, allowed, totals.minerals[name].value])]', replace: ']', fails: [N.overBudget] },
  { name: 'an unknown option left out of the verdict', find: "if (unknown.length) {\n    return { ...base, verdict: 'unknown'", replace: "if (false) {\n    return { ...base, verdict: 'unknown'", fails: [N.unknownAccounting] },
  { name: 'an unsupported option left out of the verdict', find: "if (unsupported.length) {\n    return { ...base, verdict: 'unsupported'", replace: "if (false) {\n    return { ...base, verdict: 'unsupported'", fails: [N.unsupportedOptions] },
  { name: 'every evaluation admitted before ranking', find: "if (evaluation.verdict === 'feasible') {", replace: 'if (true) {', fails: [N.overBudget, N.unknownAccounting, N.unsupportedOptions] },
  { name: 'every evaluation not infeasible admitted before ranking', find: "if (evaluation.verdict === 'feasible') {", replace: "if (evaluation.verdict !== 'infeasible') {", fails: [N.unknownAccounting, N.unsupportedOptions] },
  { name: 'an effect with a rule counted without the rule confirmed', find: 'const verified = Boolean(rule) && rule.verification === STATUS.CONFIRMED', replace: 'const verified = Boolean(rule)', fails: [N.efficacy] },
  { name: 'an effect with a value counted without being verified', find: 'const counted = verified && value !== null', replace: 'const counted = value !== null', fails: [N.efficacy] },
  { name: 'the guidance of the candidate left out of its hit chance', find: 'atg: input.options.terminal, eccm: input.options.eccm', replace: 'atg: 1, eccm: input.options.eccm', fails: [N.efficacy] },
  { name: 'a ground pod not unsupported', find: 'if (input.groundPod) {', replace: 'if (false) {', fails: [N.unsupportedOptions] },
  { name: 'an enhanced radiation warhead not unsupported', find: 'if (input.enhancedRadiation && !found.warhead) {', replace: 'if (false) {', fails: [N.unsupportedOptions] },
  { name: 'a retargeting level above 1 not unsupported', find: 'if (input.options.retarget > VALIDATED_RETARGETING && !found.retarget) {', replace: 'if (false) {', fails: [N.unsupportedOptions] },
  { name: 'a retargeting level above 1 given its size', find: 'found.retarget = { reason: RETARGETING_REASON, size: true }', replace: 'found.retarget = { reason: RETARGETING_REASON, size: false }', fails: [N.unsupportedOptions] },
  { name: 'the size and the cost of an option swapped', find: "msp: result(entry.msp, 'MSP'), bp: result(entry.bp, 'BP', outside)", replace: "msp: result(entry.bp, 'MSP'), bp: result(entry.msp, 'BP', outside)", fails: [N.roundTrip] },
  { name: 'an option with an unknown figure reported known', find: "const status = rejection ? 'unsupported' : complete ? 'known' : 'unknown'", replace: "const status = rejection ? 'unsupported' : 'known'", fails: [N.roundTrip, N.unknownAccounting] },
  { name: 'the minerals of the totals taken from one mineral', find: "missileFigure(raw.minerals[name], 'minerals', why, outside)", replace: "missileFigure(raw.minerals.Tritanium, 'minerals', why, outside)", fails: [N.roundTrip] },
  { name: 'the size limit of a candidate dropped', find: "sizeLimit: amountOf(optional(candidate.sizeLimit, 0), 'sizeLimit'),", replace: 'sizeLimit: 0,', fails: [N.roundTrip, N.overBudget] },
  { name: 'the decoys of a candidate dropped', find: "decoys: countOf(optional(candidate.decoys, 0), 'decoys'),", replace: 'decoys: 0,', fails: [N.roundTrip] },
  { name: 'the second stages of a candidate dropped', find: "const stages = countOf(optional(candidate.stages, hasStage ? 1 : 0), 'stages')", replace: 'const stages = 0', fails: [N.roundTrip] },
  { name: 'the size of an engine that is not known dropped', find: "storedMsp: techOf(engine.storedMsp, 'engine.storedMsp'),", replace: 'storedMsp: 0,', fails: [N.roundTrip] },
  { name: 'a tech that is not known read as 0', find: '(value === null || value === undefined ? null : amountOf(value, name))', replace: '(value === null || value === undefined ? 0 : amountOf(value, name))', fails: [N.unknownAccounting] },
  { name: 'an engine with a tech that is not known designed from nothing', find: 'if (lacking.length) {', replace: 'if (false) {', fails: [N.unknownAccounting] },
  { name: 'a size that is not valid accepted', find: "if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {", replace: 'if (false) {', fails: [N.validation] },
  { name: 'a field the candidate does not have accepted', find: 'if (extra.length) {', replace: 'if (false) {', fails: [N.validation] },
  { name: 'the efficacy rule registered as confirmed', find: "units: '',\n  verification: 'assumed',\n  structure: ['design.missileAccounting', 'the missileHit rules'],", replace: "units: '',\n  verification: 'confirmed',\n  structure: ['design.missileAccounting', 'the missileHit rules'],", fails: [N.registered] },
  { name: 'a cost beyond the checked quantities confirmed', find: 'const outside = missileCostOutside(input, raw)', replace: 'const outside = []', fails: [N.provenance] },
  { name: 'the highest checked quantity itself estimated', find: 'found[id] > MISSILE_COST_DOMAIN[id] && !agrees(found[id], MISSILE_COST_DOMAIN[id])', replace: 'found[id] >= MISSILE_COST_DOMAIN[id]', fails: [N.provenance] },
  { name: 'the checked thermal sensor strength raised past the modded sample', find: 'thermalStrength: 0.18', replace: 'thermalStrength: 150', fails: [N.provenance] },
  { name: 'the sensor strengths left out of the cost domain', find: "{ id: 'thermalStrength', label: 'thermal sensor strength', read: (_input, raw) => raw.strengths.thermal },", replace: "{ id: 'thermalStrength', label: 'thermal sensor strength', read: () => null },", fails: [N.provenance] },
  { name: 'the sensor sizes left out of the cost domain', find: "{ id: 'thermalMsp', label: 'thermal sensor size', read: (input) => input.thermalMsp },", replace: "{ id: 'thermalMsp', label: 'thermal sensor size', read: () => null },", fails: [N.provenance] },
  { name: 'the warhead damage left out of the cost domain', find: "{ id: 'warheadDamage', label: 'warhead damage', read: (input, raw) => (input.shipDecoy ? 0 : raw.baseWarheadDamage) },", replace: "{ id: 'warheadDamage', label: 'warhead damage', read: () => null },", fails: [N.provenance] },
  { name: 'the reactor output left out of the cost domain', find: "{ id: 'reactorOutput', label: 'sensor reactor output', read: (_input, raw) => raw.reactorOutput },", replace: "{ id: 'reactorOutput', label: 'sensor reactor output', read: () => null },", fails: [N.provenance] },
  { name: 'the engine cost left out of the cost domain', find: "{ id: 'engineBp', label: 'engine cost', read: (input) => (input.engine && input.engines > 0 ? (input.engine.missing ? null : input.engine.cost * input.engines) : 0) },", replace: "{ id: 'engineBp', label: 'engine cost', read: () => null },", fails: [N.provenance] },
  { name: 'the endurance and flight time of second stages confirmed', find: 'const staged = input.stages > 0 ? [STAGED_FLIGHT_ASSUMPTION] : []', replace: 'const staged = []', fails: [N.provenance] },
  { name: 'the feasibility taken at its own status', find: 'parts: compared, compute:', replace: 'parts: {}, compute:', fails: [N.provenance] },
  { name: 'an estimated figure counted as confirmed', find: 'rule.verification === STATUS.CONFIRMED && !weak', replace: 'rule.verification === STATUS.CONFIRMED', fails: [N.provenance] },
  { name: 'an omitted stage mineral read as 0', find: '[name, amountOf(stage.minerals[name], ', replace: '[name, amountOf(stage.minerals[name] ?? 0, ', fails: [N.validation] },
  { name: 'an engine counted with no engine accepted', find: 'if (engines > 0 && !hasEngine) {', replace: 'if (false) {', fails: [N.validation] },
  { name: 'a stage counted with no stage accepted', find: 'if (stages > 0 && !hasStage) {', replace: 'if (false) {', fails: [N.validation] },
  { name: 'the engines of an engine-less saved design counted', find: 'engines: engineMounted ? row.NumEngines : 0', replace: 'engines: row.NumEngines', fails: [N.roundTrip, N.validation] },
  { name: 'the Vendarite of a saved stage left out', find: 'Corundium: stage.row.Cost - stored, Vendarite: 0 }', replace: 'Corundium: stage.row.Cost - stored }', fails: [N.roundTrip] },
  { name: 'the engine of a saved design counted from the record given', find: 'engines: engineMounted ? row.NumEngines : 0', replace: 'engines: engine ? row.NumEngines : 0', fails: [N.mounting] },
  { name: 'the second stages of a saved design counted from the record given', find: 'stages: stageMounted ? row.NumSS : 0', replace: 'stages: stage ? row.NumSS : 0', fails: [N.mounting] },
  { name: 'a mounted engine given no record dropped', find: 'engine: engineMounted ? engine || missingMissileEngine(row) : null', replace: 'engine: engine || null', fails: [N.mounting] },
  { name: 'a mounted second stage given no record dropped', find: 'stage: stageMounted ? stage || { missing: true } : null', replace: 'stage: stage || null', fails: [N.mounting] },
  { name: 'an engine given for a row that mounts none accepted', find: 'if (!engineMounted && engine) {', replace: 'if (false) {', fails: [N.mounting] },
  { name: 'a second stage given for a row that mounts none accepted', find: 'if (!stageMounted && stage) {', replace: 'if (false) {', fails: [N.mounting] },
  { name: 'a mounted part with no count accepted', find: 'if ((engineMounted && !(row.NumEngines > 0)) || (stageMounted && !(row.NumSS > 0))) {', replace: 'if (false) {', fails: [N.mounting] },
  { name: 'the engine size the row does not store read as 0', find: 'storedMsp: row.MSPEngine > 0 ? row.MSPEngine : null', replace: 'storedMsp: row.MSPEngine', fails: [N.mounting] },
  { name: 'an engine mounted read from the count of the row', find: 'const mountsMissileEngine = (row) => row.EngineID > 0 || row.MSPEngine > 0 || row.Speed > 0', replace: 'const mountsMissileEngine = (row) => row.NumEngines > 0', fails: [N.mounting] },
]

// ---------- sensors and fire controls ----------

// Sensor and fire control differences checked by hand, each pinned to its game, component, field and the stored and computed figures observed (the library's `knownDifference` explains a difference only while both still match, in that game). The computed figure is the rule at the component's tech rows. All of them are rows of the modded save (game 140). The reconciliation's alternatives (implied techs, a tenth of the cost, an uncapped range) are diagnostics that point at the pattern of a row; they explain nothing, so a row not pinned here is a mismatch.
const TENTH_TIE = "the stored Cost is a tenth of the rule's with the .25 tie kept as .3 (the Uridium 1125 or 525 times the ECCM factor 1.25 is a figure ending in .25, stored rounded up to 1 decimal, and the Corbomite is the stored Cost less the Uridium); the other modded fire controls on the same techs store the exact tenth, and the cause is not identified"
const TENTH_PLUS = "the stored Cost is 1.1 and 0.6 over the Uridium times the ECCM factor on these two multi-weapon fire controls whose Uridium is the exact tenth of the rule's at the stored (uncapped) range, and the Corbomite is the stored Cost less the Uridium; the cause is not identified"
const TRACKING_FLOOR = 'a tracking multiplier of 0.33 on the speed rating 300000 gives 99000 km/s and the save stores 100000, which is the speed rating of another tech in the modded save; no tracking speed the rules give from the techs this fire control names matches, and the cause is not identified'
const TENTH_SHORT = "the stored cost figures are a tenth of the rule's at the tracking 99000 the rules give, within 0.1 to 0.2 under it (for example 1732.4 against 1732.5); the stored tracking is 100000 and the cause is not identified"

const TENTH = "the stored cost figures are one tenth of the rule's (the Uridium agrees at a tenth, and so do the other cost figures of the component); the cause is not identified"
const UNCAPPED = 'the save stores the range uncapped, above the 1,400,000 km limit the rules apply, and the figures that follow the range are those of the stored one; the cause is not identified'
const UNCAPPED_TENTH = "the save stores the range uncapped, above the 1,400,000 km limit the rules apply, and the stored cost figures are one tenth of the rule's at that stored range; the cause is not identified"
const IMPLIED_DISTANCE_UNCAPPED_TENTH = "the stored figures are those of a distance rating other than the one the tech row holds (the stored range over the range multiplier), at which they agree, with the range stored uncapped above 1,400,000 km and the cost figures one tenth of the rule's; the cause is not identified"
const IMPLIED_STRENGTH = 'the stored figures are those of an active sensor strength other than the one the tech row holds (the stored strength over the size), at which the range and the cost figures also agree; the cause is not identified'
const IMPLIED_SENSITIVITY_TENTH = "the stored figures are those of a sensitivity other than the one the tech row holds (the stored sensitivity over the size), at which they agree, with the cost figures one tenth of the rule's; the cause is not identified"

const KNOWN_SENSOR_ROWS = [
  { game: 140, id: 500238, field: 'Cost', stored: 1406.3, computed: 5468.75, reason: TENTH_TIE },
  { game: 140, id: 500238, field: 'Corbomite', stored: 281.3, computed: 1093.75, reason: TENTH_TIE },
  { game: 140, id: 500265, field: 'Cost', stored: 656.3, computed: 6562.5, reason: TENTH_TIE },
  { game: 140, id: 500265, field: 'Corbomite', stored: 131.3, computed: 1312.5, reason: TENTH_TIE },
  { game: 140, id: 500380, field: 'Tracking', stored: 100000, computed: 99000, reason: TRACKING_FLOOR },
  { game: 140, id: 500380, field: 'Cost', stored: 2165.6, computed: 5414, reason: TENTH_SHORT },
  { game: 140, id: 500380, field: 'Uridium', stored: 1732.4, computed: 4331.2, reason: TENTH_SHORT },
  { game: 140, id: 500380, field: 'Corbomite', stored: 433.2, computed: 1082.8, reason: TENTH_SHORT },
  { game: 140, id: 500598, field: 'Tracking', stored: 100000, computed: 99000, reason: TRACKING_FLOOR },
  { game: 140, id: 500598, field: 'Cost', stored: 5568.8, computed: 10828.125, reason: TENTH_SHORT },
  { game: 140, id: 500598, field: 'Uridium', stored: 4454.8, computed: 8662.5, reason: TENTH_SHORT },
  { game: 140, id: 500598, field: 'Corbomite', stored: 1114, computed: 2165.625, reason: TENTH_SHORT },
  { game: 140, id: 500599, field: 'Tracking', stored: 100000, computed: 99000, reason: TRACKING_FLOOR },
  { game: 140, id: 500599, field: 'Cost', stored: 2784.4, computed: 5414, reason: TENTH_SHORT },
  { game: 140, id: 500599, field: 'Uridium', stored: 2227.4, computed: 4331.2, reason: TENTH_SHORT },
  { game: 140, id: 500599, field: 'Corbomite', stored: 557, computed: 1082.8, reason: TENTH_SHORT },
  { game: 140, id: 500809, field: 'Tracking', stored: 100000, computed: 99000, reason: TRACKING_FLOOR },
  { game: 140, id: 500809, field: 'Cost', stored: 4331.2, computed: 10828.125, reason: TENTH_SHORT },
  { game: 140, id: 500809, field: 'Uridium', stored: 3464.8, computed: 8662.5, reason: TENTH_SHORT },
  { game: 140, id: 500809, field: 'Corbomite', stored: 866.4, computed: 2165.625, reason: TENTH_SHORT },
  { game: 140, id: 500810, field: 'Cost', stored: 15001.1, computed: 6562.5, reason: TENTH_PLUS },
  { game: 140, id: 500810, field: 'Corbomite', stored: 3001.1, computed: 1312.5, reason: TENTH_PLUS },
  { game: 140, id: 500811, field: 'Cost', stored: 7500.6, computed: 3281.25, reason: TENTH_PLUS },
  { game: 140, id: 500811, field: 'Corbomite', stored: 1500.6, computed: 656.25, reason: TENTH_PLUS },
  { game: 140, id: 500208, field: 'Cost', stored: 125, computed: 1250, reason: TENTH },
  { game: 140, id: 500208, field: 'Uridium', stored: 125, computed: 1250, reason: TENTH },
  { game: 140, id: 500209, field: 'Cost', stored: 125, computed: 1250, reason: TENTH },
  { game: 140, id: 500209, field: 'Uridium', stored: 125, computed: 1250, reason: TENTH },
  { game: 140, id: 500213, field: 'Cost', stored: 2625, computed: 26250, reason: TENTH },
  { game: 140, id: 500213, field: 'Uridium', stored: 2100, computed: 21000, reason: TENTH },
  { game: 140, id: 500213, field: 'Corbomite', stored: 525, computed: 5250, reason: TENTH },
  { game: 140, id: 500238, field: 'Range', stored: 3600000, computed: 1400000, reason: IMPLIED_DISTANCE_UNCAPPED_TENTH },
  { game: 140, id: 500238, field: 'Uridium', stored: 1125, computed: 4375, reason: IMPLIED_DISTANCE_UNCAPPED_TENTH },
  { game: 140, id: 500240, field: 'Range', stored: 2400000, computed: 1400000, reason: IMPLIED_DISTANCE_UNCAPPED_TENTH },
  { game: 140, id: 500240, field: 'Cost', stored: 3750, computed: 21875, reason: IMPLIED_DISTANCE_UNCAPPED_TENTH },
  { game: 140, id: 500240, field: 'Uridium', stored: 3000, computed: 17500, reason: IMPLIED_DISTANCE_UNCAPPED_TENTH },
  { game: 140, id: 500240, field: 'Corbomite', stored: 750, computed: 4375, reason: IMPLIED_DISTANCE_UNCAPPED_TENTH },
  { game: 140, id: 500243, field: 'Cost', stored: 1250, computed: 12500, reason: TENTH },
  { game: 140, id: 500243, field: 'Uridium', stored: 1250, computed: 12500, reason: TENTH },
  { game: 140, id: 500244, field: 'Cost', stored: 1250, computed: 12500, reason: TENTH },
  { game: 140, id: 500244, field: 'Uridium', stored: 1250, computed: 12500, reason: TENTH },
  { game: 140, id: 500265, field: 'Uridium', stored: 525, computed: 5250, reason: TENTH },
  { game: 140, id: 500380, field: 'Range', stored: 5600000, computed: 1400000, reason: UNCAPPED },
  { game: 140, id: 500383, field: 'Cost', stored: 2500, computed: 25000, reason: TENTH },
  { game: 140, id: 500383, field: 'Uridium', stored: 2500, computed: 25000, reason: TENTH },
  { game: 140, id: 500384, field: 'Cost', stored: 2500, computed: 25000, reason: TENTH },
  { game: 140, id: 500384, field: 'Uridium', stored: 2500, computed: 25000, reason: TENTH },
  { game: 140, id: 500389, field: 'Range', stored: 19200000, computed: 1400000, reason: UNCAPPED_TENTH },
  { game: 140, id: 500389, field: 'Cost', stored: 4500, computed: 3281.25, reason: UNCAPPED_TENTH },
  { game: 140, id: 500389, field: 'Uridium', stored: 3600, computed: 2625, reason: UNCAPPED_TENTH },
  { game: 140, id: 500389, field: 'Corbomite', stored: 900, computed: 656.25, reason: UNCAPPED_TENTH },
  { game: 140, id: 500390, field: 'Range', stored: 12000000, computed: 1400000, reason: UNCAPPED_TENTH },
  { game: 140, id: 500390, field: 'Cost', stored: 2812.5, computed: 3281.25, reason: UNCAPPED_TENTH },
  { game: 140, id: 500390, field: 'Uridium', stored: 2250, computed: 2625, reason: UNCAPPED_TENTH },
  { game: 140, id: 500390, field: 'Corbomite', stored: 562.5, computed: 656.25, reason: UNCAPPED_TENTH },
  { game: 140, id: 500391, field: 'Range', stored: 19200000, computed: 1400000, reason: UNCAPPED_TENTH },
  { game: 140, id: 500391, field: 'Cost', stored: 9000, computed: 6562.5, reason: UNCAPPED_TENTH },
  { game: 140, id: 500391, field: 'Uridium', stored: 7200, computed: 5250, reason: UNCAPPED_TENTH },
  { game: 140, id: 500391, field: 'Corbomite', stored: 1800, computed: 1312.5, reason: UNCAPPED_TENTH },
  { game: 140, id: 500392, field: 'Range', stored: 12000000, computed: 1400000, reason: UNCAPPED_TENTH },
  { game: 140, id: 500392, field: 'Cost', stored: 5625, computed: 6562.5, reason: UNCAPPED_TENTH },
  { game: 140, id: 500392, field: 'Uridium', stored: 4500, computed: 5250, reason: UNCAPPED_TENTH },
  { game: 140, id: 500392, field: 'Corbomite', stored: 1125, computed: 1312.5, reason: UNCAPPED_TENTH },
  { game: 140, id: 500394, field: 'Cost', stored: 62500, computed: 625000, reason: TENTH },
  { game: 140, id: 500394, field: 'Uridium', stored: 62500, computed: 625000, reason: TENTH },
  { game: 140, id: 500395, field: 'Cost', stored: 62500, computed: 625000, reason: TENTH },
  { game: 140, id: 500395, field: 'Uridium', stored: 62500, computed: 625000, reason: TENTH },
  { game: 140, id: 500598, field: 'Range', stored: 7200000, computed: 1400000, reason: UNCAPPED },
  { game: 140, id: 500599, field: 'Range', stored: 7200000, computed: 1400000, reason: UNCAPPED },
  { game: 140, id: 500607, field: 'Strength', stored: 0.2, computed: 0.04, reason: IMPLIED_STRENGTH },
  { game: 140, id: 500607, field: 'Range', stored: 25231295.719346385, computed: 11283778.477771595, reason: IMPLIED_STRENGTH },
  { game: 140, id: 500607, field: 'Cost', stored: 0.25, computed: 0, reason: IMPLIED_STRENGTH },
  { game: 140, id: 500607, field: 'Uridium', stored: 0.2, computed: 0, reason: IMPLIED_STRENGTH },
  { game: 140, id: 500607, field: 'Corbomite', stored: 0.05, computed: 0, reason: IMPLIED_STRENGTH },
  { game: 140, id: 500608, field: 'Sensitivity', stored: 200, computed: 1, reason: IMPLIED_SENSITIVITY_TENTH },
  { game: 140, id: 500608, field: 'Cost', stored: 25, computed: 1.2, reason: IMPLIED_SENSITIVITY_TENTH },
  { game: 140, id: 500608, field: 'Uridium', stored: 25, computed: 1.2, reason: IMPLIED_SENSITIVITY_TENTH },
  { game: 140, id: 500609, field: 'Sensitivity', stored: 200, computed: 1, reason: IMPLIED_SENSITIVITY_TENTH },
  { game: 140, id: 500609, field: 'Cost', stored: 25, computed: 1.2, reason: IMPLIED_SENSITIVITY_TENTH },
  { game: 140, id: 500609, field: 'Uridium', stored: 25, computed: 1.2, reason: IMPLIED_SENSITIVITY_TENTH },
  { game: 140, id: 500730, field: 'Strength', stored: 144, computed: 460.8, reason: IMPLIED_STRENGTH },
  { game: 140, id: 500730, field: 'Range', stored: 1354053417.33037, computed: 2422204389.057253, reason: IMPLIED_STRENGTH },
  { game: 140, id: 500730, field: 'Cost', stored: 225, computed: 720, reason: IMPLIED_STRENGTH },
  { game: 140, id: 500730, field: 'Uridium', stored: 180, computed: 576, reason: IMPLIED_STRENGTH },
  { game: 140, id: 500730, field: 'Corbomite', stored: 45, computed: 144, reason: IMPLIED_STRENGTH },
  { game: 140, id: 500809, field: 'Range', stored: 5600000, computed: 1400000, reason: UNCAPPED },
  { game: 140, id: 500810, field: 'Range', stored: 32000000, computed: 1400000, reason: UNCAPPED_TENTH },
  { game: 140, id: 500810, field: 'Uridium', stored: 12000, computed: 5250, reason: UNCAPPED_TENTH },
  { game: 140, id: 500811, field: 'Range', stored: 32000000, computed: 1400000, reason: UNCAPPED_TENTH },
  { game: 140, id: 500811, field: 'Uridium', stored: 6000, computed: 2625, reason: UNCAPPED_TENTH },
  { game: 140, id: 501040, field: 'Cost', stored: 6250, computed: 62500, reason: TENTH },
  { game: 140, id: 501040, field: 'Uridium', stored: 6250, computed: 62500, reason: TENTH },
  { game: 140, id: 501041, field: 'Cost', stored: 6250, computed: 62500, reason: TENTH },
  { game: 140, id: 501041, field: 'Uridium', stored: 6250, computed: 62500, reason: TENTH },
  { game: 140, id: 501139, field: 'Range', stored: 24000000, computed: 1400000, reason: UNCAPPED_TENTH },
  { game: 140, id: 501139, field: 'Cost', stored: 5625, computed: 3281.25, reason: UNCAPPED_TENTH },
  { game: 140, id: 501139, field: 'Uridium', stored: 4500, computed: 2625, reason: UNCAPPED_TENTH },
  { game: 140, id: 501139, field: 'Corbomite', stored: 1125, computed: 656.25, reason: UNCAPPED_TENTH },
  { game: 140, id: 501140, field: 'Range', stored: 24000000, computed: 1400000, reason: UNCAPPED_TENTH },
  { game: 140, id: 501140, field: 'Cost', stored: 11250, computed: 6562.5, reason: UNCAPPED_TENTH },
  { game: 140, id: 501140, field: 'Uridium', stored: 9000, computed: 5250, reason: UNCAPPED_TENTH },
  { game: 140, id: 501140, field: 'Corbomite', stored: 2250, computed: 1312.5, reason: UNCAPPED_TENTH },
  { game: 140, id: 501141, field: 'Range', stored: 40000000, computed: 1400000, reason: UNCAPPED_TENTH },
  { game: 140, id: 501141, field: 'Cost', stored: 18750, computed: 6562.5, reason: UNCAPPED_TENTH },
  { game: 140, id: 501141, field: 'Uridium', stored: 15000, computed: 5250, reason: UNCAPPED_TENTH },
  { game: 140, id: 501141, field: 'Corbomite', stored: 3750, computed: 1312.5, reason: UNCAPPED_TENTH },
  { game: 140, id: 501142, field: 'Range', stored: 40000000, computed: 1400000, reason: UNCAPPED_TENTH },
  { game: 140, id: 501142, field: 'Cost', stored: 9375, computed: 3281.25, reason: UNCAPPED_TENTH },
  { game: 140, id: 501142, field: 'Uridium', stored: 7500, computed: 2625, reason: UNCAPPED_TENTH },
  { game: 140, id: 501142, field: 'Corbomite', stored: 1875, computed: 656.25, reason: UNCAPPED_TENTH },
]

const loadSensorFixtures = () => new Map(JSON.parse(fs.readFileSync(SENSOR_FIXTURES, 'utf8')).fixtures.map((fixture) => [fixture.label, fixture]))

// Writes the sensors and fire controls of the scope (those the race owns, or those any race of the game holds with --all-game) as a fixture under `options.label` in the fixtures file, replacing a fixture of that label and keeping the others, so the checks and their planted faults run without a save.
const exportSensorFixture = async (context, options) => {
  const { database, parameters, allGame, library } = context
  const fixture = await library.loadSensorFixture(appDatabase(database), parameters[':game'], allGame ? null : parameters[':race'])
  const existing = fs.existsSync(options.sensorExportFile) ? JSON.parse(fs.readFileSync(options.sensorExportFile, 'utf8')) : { fixtures: [] }
  const entry = { label: options.label, save: path.basename(options.save), game: parameters[':game'], note: options.note, scope: allGame ? 'every sensor and fire control a race of the game holds' : `the sensors and fire controls race ${parameters[':race']} owns`, ...fixture }
  const fixtures = [...existing.fixtures.filter((held) => held.label !== options.label), entry].sort((a, b) => a.label.localeCompare(b.label))

  fs.writeFileSync(options.sensorExportFile, `${JSON.stringify({ fixtures })}\n`)

  return { components: fixture.components.length, techs: Object.keys(fixture.techs).length }
}

// Every comparison of a fixture's components, in a report.
const reconcileSensorFixture = (library, fixture, scope, { ruleIds = RULE_IDS.sensor } = {}) => {
  const report = new MissileReport('sensor', ruleIds, scope, library, fixture.game, KNOWN_SENSOR_ROWS)
  const kinds = {}

  for (const component of fixture.components) {
    const result = library.reconcileSensor(fixture, component)

    kinds[result.kind] = (kinds[result.kind] || 0) + 1
    result.comparisons.forEach((entry) => report.record({ id: result.id, name: result.name }, entry))
  }

  report.notes.push(`scope: ${fixture.components.length} components (${Object.entries(kinds).map(([kind, count]) => `${count} ${kind}`).join(', ')}), each rebuilt from the techs its slots name, found by tech type`)

  return report
}

const checkSensors = async (context) => {
  const { database, parameters, allGame, library } = context
  const fixture = await library.loadSensorFixture(appDatabase(database), parameters[':game'], allGame ? null : parameters[':race'])

  return reconcileSensorFixture(library, fixture, allGame ? 'every sensor and fire control a race of the game holds' : 'the sensors and fire controls the race owns')
}

// The components that differ from the rules in the sensor fixtures, as `fixture|component`, each explained by a pinned row above, and how many comparisons of each fixture differ. The stock fixtures have none. A comparison that moves in or out is a change to look at, not one to absorb.
const EXPECTED_SENSOR_DIFFER = new Set([
  ...['500208', '500209', '500213', '500238', '500240', '500243', '500244', '500265', '500380', '500383', '500384', '500389', '500390', '500391', '500392', '500394', '500395', '500598', '500599', '500607', '500608', '500609', '500730', '500809', '500810', '500811', '501040', '501041', '501139', '501140', '501141', '501142'].map((id) => `modded-g140|${id}`),
])
const EXPECTED_SENSOR_DIFFERENCES = { 'modded-g140': 110 }

// The figures of the sensor fixtures the rules leave unknown, as `fixture|component|field`, each for the reason the reconciliation gives: a fire control of the 1973 save that names no ECCM tech (it stores ECCM 8, cost 0 and Corbomite -25.6) has no ECCM factor to take its cost and Corbomite from. An unknown that is not listed, or a listed one that is known now, is a change to look at.
const EXPECTED_SENSOR_UNKNOWN = new Set(['boscodiogigia-1973-g140|154909|Cost', 'boscodiogigia-1973-g140|154909|Corbomite', 'boscodiogigia-1973-g140|154909|ECCM'])

// What is wrong with the sensor fixtures `data` as the library reads them: an unsupported or an unknown comparison, a difference with no reason or one not expected above, an expected one that no longer differs, or a pinned row that no longer explains a difference.
const sensorFixtureProblems = (library, data) => {
  const problems = []
  const differing = new Set()
  const unknown = new Set()
  const counts = {}
  const pinned = new Set()

  for (const fixture of data.values()) {
    for (const component of fixture.components) {
      for (const entry of library.reconcileSensor(fixture, component).comparisons) {
        const key = `${fixture.label}|${component.id}|${entry.field}`
        const { verdict, reason } = library.classify(KNOWN_SENSOR_ROWS, fixture.game, component.id, entry)

        if (verdict === 'unsupported') {
          problems.push(`${key} is unsupported`)
        } else if (verdict === 'unknown') {
          unknown.add(key)

          if (!EXPECTED_SENSOR_UNKNOWN.has(key)) {
            problems.push(`${key} is unknown: ${entry.reason || 'the save stores no figure'}`)
          }
        } else if (verdict === 'differ') {
          counts[fixture.label] = (counts[fixture.label] || 0) + 1
          differing.add(`${fixture.label}|${component.id}`)

          if (entry.explain) {
            problems.push(`${key} explains itself: a difference is explained by a pinned row only`)
          }

          if (!reason) {
            problems.push(`${key} differs with no reason`)
          } else {
            pinned.add(`${fixture.game}|${component.id}|${entry.field}`)
          }
        }
      }
    }
  }

  for (const key of differing) {
    if (!EXPECTED_SENSOR_DIFFER.has(key)) {
      problems.push(`${key} differs and is not expected`)
    }
  }

  for (const key of EXPECTED_SENSOR_DIFFER) {
    if (!differing.has(key)) {
      problems.push(`${key} is expected to differ and no longer does`)
    }
  }

  for (const label of new Set([...Object.keys(counts), ...Object.keys(EXPECTED_SENSOR_DIFFERENCES)])) {
    if ((counts[label] || 0) !== (EXPECTED_SENSOR_DIFFERENCES[label] || 0)) {
      problems.push(`${label} has ${counts[label] || 0} differing comparisons, expected ${EXPECTED_SENSOR_DIFFERENCES[label] || 0}`)
    }
  }

  for (const row of KNOWN_SENSOR_ROWS) {
    if (!pinned.has(`${row.game}|${row.id}|${row.field}`)) {
      problems.push(`the pinned row ${row.id} ${row.field} no longer explains a difference`)
    }
  }

  for (const key of EXPECTED_SENSOR_UNKNOWN) {
    if (!unknown.has(key)) {
      problems.push(`${key} is expected to be unknown and no longer is`)
    }
  }

  return problems
}

const SENSOR_CHECK_NAMES = {
  iris: 'the stored Iris of the modded save is rebuilt: range 239,365,088.371173 km, strength 18, cost 28.125 (Uridium 22.5, Corbomite 5.625), size 0.1, resolution 1, ECCM 15, CTD 1',
  active: 'every owned active sensor and missile fire control of the stock saves is rebuilt: strength, range, cost, minerals, crew, HTK, ECCM and CTD',
  pair: 'a missile fire control has twice the range of the search sensor of the same techs, size and resolution, with its strength, and the rules reproduce both',
  passive: 'the thermal and EM sensors of the stock saves are rebuilt: the sensitivity is the size times the tech, the cost that times the hardening factor to 1 decimal, all of it Uridium',
  resolution: 'a signature under the resolution cuts the range by the square of the ratio, and one at or over it cuts nothing',
  jammer: 'a sensor jammer cuts the range by 0.75 to the jammer less the ECCM only when the jammer is the stronger, and the missile hit penalty is another rule',
  signature: 'a missile is seen by a signature of its size in MSP over 20 HS, never below 0.3',
  passiveRange: 'a passive sensor sees a signature at the square root of its sensitivity times the signature, times 250,000 km',
  ladders: 'the legal sizes, resolutions and multipliers are the lists of the design window',
  inverse: 'the size sized for a range reaches it and the next smaller legal size falls short, for search sensors and missile fire controls, across resolutions, signatures and jammers',
  minimum: 'a range the smallest legal size already reaches is a minimum bound, with nothing smaller offered',
  beyond: 'a range the largest legal size cannot reach is beyond the largest, and the largest reaches its own range',
  unavailable: 'a sizing request missing a tech, a signature, a range or the ECCM a jammer needs is unavailable and never sized as 0',
  pairSize: 'the missile fire control of an engagement needs a quarter of the exact size of the search sensor, and each is the smallest legal size that reaches the range',
  beam: 'every owned beam fire control of the stock saves reproduces range, tracking, size, crew, BP and minerals',
  limits: 'a fire control range is clamped at 1,400,000 km, its cost follows the clamped range, and its size floors at 0.01 HS',
  trunc: 'the cost of a fire control uses the tracking in thousands cut to a whole number',
  request: 'a requested range and tracking are met by the smallest legal multipliers, on the tracking the game stores (rounded) and not the unrounded ratio; the next smaller falls short, a range over the limit is beyond the largest, a missing tech is unavailable, and every request is an estimate under the inverse sizing rule',
  roles: 'the techs of a component are found by tech type and not by slot; two of one type are ambiguous, a missing or unheld one makes its figures unknown, and a figure the save lacks is unknown',
  techNumbers: 'a tech row that stores no number a figure needs makes only the figures that need it unknown (the rating for the CTD or ECCM, the cost factor for the Uridium, Cost and Corbomite) and never reads it as 0',
  descriptions: 'the tech types the roles are found by are those DIM_TechType describes in every save',
  explanations: 'a difference is explained only by an audited pin of its game, component, field and figures: the alternatives (implied techs, a tenth, an uncapped range) are diagnostics, and an unpinned figure, another game, a changed figure and a re-identified component are mismatches',
  fixtures: 'the sensor fixtures reconcile: the stock saves agree everywhere, the modded save differs only where pinned, no comparison explains itself, and nothing is unknown or unsupported',
}

const S = SENSOR_CHECK_NAMES

const SENSOR_ACTIVE_FIELDS = ['Strength', 'Range', 'Cost', 'Uridium', 'Corbomite', 'Crew', 'HTK', 'ECCM', 'CTD']
const SENSOR_PASSIVE_FIELDS = ['Sensitivity', 'Cost', 'Uridium', 'Crew', 'HTK', 'CTD']
const SENSOR_BEAM_FIELDS = ['Range', 'Tracking', 'Size', 'Cost', 'Uridium', 'Corbomite', 'Crew', 'HTK', 'ECCM', 'CTD', 'SpecialFunction']
const TECH_SLOTS = ['BGTech1', 'BGTech2', 'BGTech3', 'BGTech4', 'BGTech5', 'BGTech6', 'BGTech7']

// The checks of the sensor and fire control rules over the sensor fixtures `data` (label to fixture), run on `library`: the real one, or a mutated copy that must fail the checks its mutant names. Each is [name, test], the test returning true or the reason it failed.
const sensorChecks = (library, data) => {
  const modded = data.get('modded-g140')
  const stock = data.get('stock-271-g138')
  const unmodded = ['stock-271-g138', 'later-stock-g138', 'solid-core-g138', 'v270-kristover-g143', 'boscodiogigia-1973-g140'].map((label) => data.get(label))
  const later = data.get('later-stock-g138')
  const { valueOrNull, isAvailable } = library.provenance
  const types = library.SENSOR_COMPONENT_TYPES
  const roleOf = library.SENSOR_TECH
  const componentOf = (fixture, id) => fixture.components.find((component) => component.id === id)
  const rebuilt = (fixture, id) => library.reconcileSensor(fixture, componentOf(fixture, id))
  const computedOf = (result, field) => entryOf(result, field)?.computed ?? null
  const ofTypes = (fixture, wanted) => fixture.components.filter((component) => wanted.includes(component.row.ComponentTypeID))
  const reproduces = (wanted, fields, least) => {
    let count = 0

    for (const fixture of unmodded) {
      for (const component of ofTypes(fixture, wanted).filter((part) => ![...EXPECTED_SENSOR_UNKNOWN].some((key) => key.startsWith(`${fixture.label}|${part.id}|`)))) {
        const failure = expectVerdicts(library, library.reconcileSensor(fixture, component), fields, 'agree')

        if (failure !== true) {
          return `${fixture.label}: ${failure}`
        }

        count++
      }
    }

    return expectThat(`only ${count} components were rebuilt, expected at least ${least}`, count >= least)
  }
  const techOf = (fixture, id, role) => library.sensorTechOf(fixture, componentOf(fixture, id).row, roleOf[role])
  const sameTechs = (a, b) => TECH_SLOTS.map((slot) => a.row[slot]).sort().join() === TECH_SLOTS.map((slot) => b.row[slot]).sort().join()
  const pairsOf = (fixture) => ofTypes(fixture, [types.active]).flatMap((search) => ofTypes(fixture, [types.missileFireControl]).filter((fire) => fire.row.Size === search.row.Size && fire.row.Resolution === search.row.Resolution && sameTechs(search, fire)).map((fire) => [fixture, search, fire]))
  const stockTechs = { strengthTech: techOf(stock, 154596, 'strength').info, emTech: techOf(stock, 154596, 'em').info }
  const modes = Object.values(library.SENSOR_MODES)
  const sizes = library.SENSOR_SIZES_HS
  const rangeAt = ({ sizeHS, mode, resolution, signature, jammer, eccm }) => library.activeSensorDesign({ sizeHS, resolution, ...stockTechs, hardeningRating: 0, hardeningCost: 0, eccmRating: 0, eccmCost: 0, mode }).rangeKm * library.sensorResolutionFactor({ signature, resolution }) * (jammer > 0 ? library.sensorJammerFactor({ jammer, eccm }) : 1)
  const sized = (request) => valueOrNull(library.sensorSizeForRange({ ...stockTechs, ...request }))
  const fireControl = { rangeMultiplier: 4, trackingMultiplier: 2, distanceRating: 8000000, speedRating: 5000, weaponNumber: 1, hardeningRating: 100, hardeningCost: 1, eccmRating: 0, eccmCost: 1 }
  const beamTechs = { distanceRating: 80000, speedRating: 5000, weaponNumber: 1, hardeningRating: 100, hardeningCost: 1, eccmRating: 3, eccmCost: 1.3 }
  const edited = (fixture, id, edit) => {
    const copy = clone(fixture)

    edit(copy, componentOf(copy, id))

    return { copy, result: library.reconcileSensor(copy, componentOf(copy, id)) }
  }
  const sizingCases = []

  for (const mode of modes) {
    for (const resolution of [1, 20, 100]) {
      for (const [signature, jammer, eccm] of [[200, 0, null], [resolution / 2, 0, null], [200, 6, 2], [resolution / 2, 5, 1]]) {
        for (const sizeHS of [0.35, 1.23, 2.6, 7.7, 33.3, 0.5, 2, 12]) {
          sizingCases.push({ mode, resolution, signature, jammer, eccm, sizeHS })
        }
      }
    }
  }

  const firstLegal = (sizeHS) => sizes.find((legal) => legal >= sizeHS - 1e-12)
  const sizesOf = (fixture, wanted) => ofTypes(fixture, wanted).length

  return [
    [S.iris, () => {
      const iris = componentOf(modded, 500211).row
      const result = rebuilt(modded, 500211)

      return firstFailure(expectNear('stored range', iris.MaxSensorRange, 239365088.371173), expectNear('stored cost', iris.Cost, 28.125), expectNear('stored Uridium', iris.Uridium, 22.5), expectNear('stored Corbomite', iris.Corbomite, 5.625), expectNear('stored size', iris.Size, 0.1), expectNear('stored resolution', iris.Resolution, 1), expectNear('stored ECCM', iris.ECCM, 15), expectNear('stored CTD', iris.ElectronicCTD, 1), expectNear('stored strength', iris.ComponentValue, 18), expectNear('range', computedOf(result, 'Range'), 239365088.371173), expectNear('strength', computedOf(result, 'Strength'), 18), expectNear('cost', computedOf(result, 'Cost'), 28.125), expectNear('Uridium', computedOf(result, 'Uridium'), 22.5), expectNear('Corbomite', computedOf(result, 'Corbomite'), 5.625), expectNear('ECCM', computedOf(result, 'ECCM'), 15), expectNear('CTD', computedOf(result, 'CTD'), 1), expectVerdicts(library, result, SENSOR_ACTIVE_FIELDS, 'agree'))
    }],
    [S.active, () => firstFailure(reproduces([types.active, types.missileFireControl], SENSOR_ACTIVE_FIELDS, 60), expectThat('the stock saves hold no resolution 50 or more fire control', unmodded.some((fixture) => ofTypes(fixture, [types.missileFireControl]).some((component) => component.row.Resolution >= 50))))],
    [S.pair, () => {
      const pairs = unmodded.flatMap(pairsOf)
      const search = componentOf(stock, 154596).row
      const fire = componentOf(stock, 154632).row
      const design = (mode) => library.activeSensorDesign({ sizeHS: 0.1, resolution: 1, ...stockTechs, hardeningRating: 100, hardeningCost: 1, eccmRating: 0, eccmCost: 1, mode })

      return firstFailure(expectThat(`only ${pairs.length} pairs of equal techs, size and resolution were found`, pairs.length >= 3), expectNear('stored range of 154632 over 154596', fire.MaxSensorRange / search.MaxSensorRange, 2), expectNear('search range of the rule', design(library.SENSOR_MODES.search).rangeKm, search.MaxSensorRange), expectNear('fire control range of the rule', design(library.SENSOR_MODES.missileFireControl).rangeKm, fire.MaxSensorRange), expectNear('the same sensor as a fire control', design(library.SENSOR_MODES.missileFireControl).rangeKm / design(library.SENSOR_MODES.search).rangeKm, 2), ...pairs.map(([fixture, searchPart, firePart]) => {
        const a = library.reconcileSensor(fixture, searchPart)
        const b = library.reconcileSensor(fixture, firePart)

        return firstFailure(expectNear(`stored ranges of ${searchPart.id} and ${firePart.id}`, firePart.row.MaxSensorRange / searchPart.row.MaxSensorRange, 2), expectNear(`computed ranges of ${searchPart.id} and ${firePart.id}`, computedOf(b, 'Range') / computedOf(a, 'Range'), 2), expectNear(`strengths of ${searchPart.id} and ${firePart.id}`, computedOf(b, 'Strength'), computedOf(a, 'Strength')), expectVerdicts(library, a, ['Range', 'Strength'], 'agree'), expectVerdicts(library, b, ['Range', 'Strength'], 'agree'))
      }))
    }],
    [S.passive, () => {
      const small = library.passiveSensorDesign({ sizeHS: 0.3, sensitivityTech: 5, hardeningRating: 100, hardeningCost: 1.23 })
      const large = library.passiveSensorDesign({ sizeHS: 2, sensitivityTech: 5, hardeningRating: 100, hardeningCost: 1 })

      return firstFailure(reproduces([types.thermal, types.em], SENSOR_PASSIVE_FIELDS, 40), expectNear('sensitivity of 0.3 HS at 5', small.sensitivity, 1.5), expectNear('cost to 1 decimal', small.cost, 1.8), expectNear('all of it Uridium', small.uridium, small.cost), expectNear('crew of 2 HS', large.crew, 4), expectNear('HTK of 2 HS', large.htk, 1), expectNear('HTK of 0.3 HS', small.htk, 0), expectNear('sensitivity of 2 HS at 5', large.sensitivity, 10), expectNear('CTD', large.ctd, 100), expectVerdicts(library, rebuilt(stock, 154091), SENSOR_PASSIVE_FIELDS, 'agree'), expectNear('thermal 1 HS sensitivity', computedOf(rebuilt(stock, 154091), 'Sensitivity'), 5), expectNear('EM 0.1 HS sensitivity', computedOf(rebuilt(stock, 154090), 'Sensitivity'), 0.5), expectNear('EM 0.1 HS crew', computedOf(rebuilt(stock, 154090), 'Crew'), 0))
    }],
    [S.resolution, () => {
      const iris = componentOf(modded, 500211).row.MaxSensorRange
      const fire = componentOf(stock, 154111).row.MaxSensorRange
      const factor = (signature, resolution) => library.sensorResolutionFactor({ signature, resolution })
      const range = (rangeKm, signature, resolution) => valueOrNull(library.sensorEffectiveRange({ rangeKm, signature, resolution }))

      return firstFailure(expectNear('half the resolution', factor(0.5, 1), 0.25), expectNear('a tenth of the resolution', factor(0.1, 1), 0.01), expectNear('3 over 6', factor(3, 6), 0.25), expectNear('at the resolution', factor(1, 1), 1), expectNear('over the resolution', factor(7, 2), 1), expectNear('Iris against 0.5 HS', range(iris, 0.5, 1), iris / 4), expectNear('Iris against 1 HS', range(iris, 1, 1), iris), expectNear('Iris against 40 HS', range(iris, 40, 1), iris), expectNear('fire control of resolution 50 against 25 HS', range(fire, 25, 50), fire / 4), expectNear('a signature of 0 is seen at no range', range(iris, 0, 1), 0), expectThat('an unknown signature gives a range', !isAvailable(library.sensorEffectiveRange({ rangeKm: iris, resolution: 1 }))))
    }],
    [S.jammer, () => {
      const factor = (jammer, eccm) => library.sensorJammerFactor({ jammer, eccm })
      const effective = (request) => library.sensorEffectiveRange({ rangeKm: 1000000, signature: 2, resolution: 1, ...request })
      const hit = valueOrNull(library.hit.jammerMultiplier({ jammer: 5, eccm: 3 }))

      return firstFailure(expectNear('jammer 5 against ECCM 3', factor(5, 3), 0.75 ** 2), expectNear('jammer 4 against ECCM 0', factor(4, 0), 0.75 ** 4), expectNear('jammer equal to the ECCM', factor(3, 3), 1), expectNear('jammer under the ECCM', factor(2, 5), 1), expectNear('the missile hit penalty is on the whole jammer', hit, 0.75 ** 5), expectThat('the sensor and the hit penalties are the same', Math.abs(hit - factor(5, 3)) > 1e-3), expectNear('range under jammer 5 against ECCM 3', valueOrNull(effective({ jammer: 5, eccm: 3 })), 562500), expectNear('range under jammer 3 against ECCM 3', valueOrNull(effective({ jammer: 3, eccm: 3 })), 1000000), expectNear('range with no jammer', valueOrNull(effective({})), 1000000), expectNear('Iris against jammer 17', valueOrNull(library.sensorEffectiveRange({ rangeKm: componentOf(modded, 500211).row.MaxSensorRange, signature: 5, resolution: 1, jammer: 17, eccm: componentOf(modded, 500211).row.ECCM })), componentOf(modded, 500211).row.MaxSensorRange * 0.75 ** 2), expectThat('a jammer with no ECCM known gives a range', !isAvailable(effective({ jammer: 5 }))))
    }],
    [S.signature, () => firstFailure(expectNear('20 MSP', library.missileSignature({ sizeMsp: 20 }), 1), expectNear('40 MSP', library.missileSignature({ sizeMsp: 40 }), 2), expectNear('8 MSP', library.missileSignature({ sizeMsp: 8 }), 0.4), expectNear('6 MSP at the floor', library.missileSignature({ sizeMsp: 6 }), 0.3), expectNear('2 MSP under the floor', library.missileSignature({ sizeMsp: 2 }), 0.3), expectNear('5 MSP under the floor', library.missileSignature({ sizeMsp: 5 }), 0.3))],
    [S.passiveRange, () => firstFailure(expectNear('sensitivity 100 against 1 HS', library.passiveDetectionRange({ sensitivity: 100, signature: 1 }), 2500000), expectNear('sensitivity 4 against 9 HS', library.passiveDetectionRange({ sensitivity: 4, signature: 9 }), 1500000), expectNear('the thermal 1 HS of the stock save against 20 HS', library.passiveDetectionRange({ sensitivity: computedOf(rebuilt(stock, 154091), 'Sensitivity'), signature: 20 }), 2500000))],
    [S.ladders, () => {
      const resolutions = library.SENSOR_RESOLUTIONS_HS
      const multipliers = library.FIRE_CONTROL_MULTIPLIERS
      const ascending = (list) => list.every((value, index) => index === 0 || value > list[index - 1])

      return firstFailure(expectNear('number of sizes', sizes.length, 77), expectNear('number of resolutions', resolutions.length, 71), expectNear('number of multipliers', multipliers.length, 391), expectThat('the lists are not ascending', ascending(sizes) && ascending(resolutions) && ascending(multipliers)), expectThat('a legal size is missing', [0.1, 0.5, 1.9, 2, 2.25, 4.75, 5, 6, 50].every((size) => sizes.includes(size))), expectThat('an illegal size is offered', [0.05, 1.95, 2.1, 4.8, 5.5, 50.5].every((size) => !sizes.includes(size))), expectThat('a legal resolution is missing', [1, 20, 25, 200, 220, 500].every((resolution) => resolutions.includes(resolution))), expectThat('an illegal resolution is offered', [0, 21, 23, 205, 210, 230, 501].every((resolution) => !resolutions.includes(resolution))), expectThat('a legal multiplier is missing', [0.1, 0.35, 1, 3.99, 4].every((multiplier) => multipliers.includes(multiplier))), expectThat('an illegal multiplier is offered', [0.09, 0.355, 4.01, 3.995].every((multiplier) => !multipliers.includes(multiplier))))
    }],
    [S.inverse, () => {
      const failures = sizingCases.map((request) => {
        const target = rangeAt(request)
        const value = sized({ mode: request.mode, targetRangeKm: target, signature: request.signature, resolution: request.resolution, jammer: request.jammer, eccm: request.eccm })
        const legal = firstLegal(request.sizeHS)
        const label = `${request.mode} ${request.sizeHS} HS at resolution ${request.resolution}, signature ${request.signature}, jammer ${request.jammer}`

        return firstFailure(expectThat(`${label} is ${value?.status}, not sized`, value?.status === 'sized'), expectThat(`${label} gives ${value?.sizeHS}, not ${legal}`, value?.sizeHS === legal), expectThat(`${label}: the size does not reach the range`, value.rangeKm >= target * (1 - 1e-9)), expectThat(`${label}: the next smaller size ${value.smallerHS} reaches it too`, value.smallerRangeKm < target * (1 - 1e-9)), expectThat(`${label}: the size below is ${value.smallerHS}`, value.smallerHS === sizes[sizes.indexOf(value.sizeHS) - 1]), expectNear(`${label} exact size`, value.exactSizeHS, request.sizeHS))
      })
      const onLadder = sizingCases.filter((request) => request.sizeHS === firstLegal(request.sizeHS))
      const edges = onLadder.map((request) => {
        const target = rangeAt(request)
        const near = sized({ mode: request.mode, targetRangeKm: target * (1 + 5e-10), signature: request.signature, resolution: request.resolution, jammer: request.jammer, eccm: request.eccm })
        const over = sized({ mode: request.mode, targetRangeKm: target * (1 + 1e-6), signature: request.signature, resolution: request.resolution, jammer: request.jammer, eccm: request.eccm })

        return firstFailure(expectThat(`${request.mode} ${request.sizeHS} HS: a range 5e-10 over is ${near?.sizeHS}, expected ${request.sizeHS} within the tolerance`, near?.sizeHS === request.sizeHS), expectThat(`${request.mode} ${request.sizeHS} HS: a range 1e-6 over is ${over?.sizeHS}, expected the next size up`, over?.sizeHS === sizes[sizes.indexOf(request.sizeHS) + 1]))
      })

      const anchors = unmodded.flatMap((fixture) => ofTypes(fixture, [types.active, types.missileFireControl]).filter((component) => sizes.includes(component.row.Size) && component.row.Resolution > 0).map((component) => ({ fixture, component })))
      const anchored = anchors.map(({ fixture, component }) => {
        const { row } = component
        const value = sized({ mode: row.ComponentTypeID === types.active ? library.SENSOR_MODES.search : library.SENSOR_MODES.missileFireControl, targetRangeKm: row.MaxSensorRange, signature: row.Resolution, resolution: row.Resolution, strengthTech: techOf(fixture, component.id, 'strength').info, emTech: techOf(fixture, component.id, 'em').info })

        return expectThat(`${fixture.label} ${component.id}: the stored range ${row.MaxSensorRange} is sized ${value?.sizeHS} HS, not the stored ${row.Size}`, value?.sizeHS === row.Size)
      })

      return firstFailure(expectThat('too few sizing requests', sizingCases.length >= 150), expectThat(`only ${anchors.length} stored sensors anchor the sizing`, anchors.length >= 20), ...failures, ...edges, ...anchored)
    }],
    [S.minimum, () => {
      const request = { mode: library.SENSOR_MODES.search, resolution: 10, signature: 50, jammer: 0, eccm: null }
      const at = (extra) => sized({ mode: request.mode, signature: request.signature, resolution: request.resolution, ...extra })
      const small = at({ targetRangeKm: 1000 })
      const exact = at({ targetRangeKm: rangeAt({ ...request, sizeHS: 0.1 }) })
      const next = at({ targetRangeKm: rangeAt({ ...request, sizeHS: 0.1 }) * (1 + 1e-6) })
      const fire = sized({ mode: library.SENSOR_MODES.missileFireControl, targetRangeKm: 1000, signature: 50, resolution: 10 })

      return firstFailure(expectThat(`1000 km is ${small?.status}`, small?.status === 'minimum-bound'), expectNear('size of 1000 km', small?.sizeHS, 0.1), expectThat('something smaller than the minimum is offered', small?.smallerHS === null && small?.smallerRangeKm === null), expectNear('minimum', small?.minimumHS, 0.1), expectThat('the minimum does not reach 1000 km', small.rangeKm >= 1000), expectThat(`the range of the minimum is ${exact?.status}`, exact?.status === 'minimum-bound'), expectThat(`a range just over the minimum is ${next?.status} at ${next?.sizeHS}`, next?.status === 'sized' && next.sizeHS === 0.2 && next.smallerHS === 0.1), expectThat(`a fire control for 1000 km is ${fire?.status}`, fire?.status === 'minimum-bound'))
    }],
    [S.beyond, () => {
      const request = { mode: library.SENSOR_MODES.search, resolution: 10, signature: 50, jammer: 0, eccm: null }
      const largest = sizes[sizes.length - 1]
      const at = (factor) => sized({ mode: request.mode, signature: request.signature, resolution: request.resolution, targetRangeKm: rangeAt({ ...request, sizeHS: largest }) * factor })
      const over = at(1.001)
      const exact = at(1)
      const fire = sized({ mode: library.SENSOR_MODES.missileFireControl, signature: 50, resolution: 10, targetRangeKm: 1e12 })

      return firstFailure(expectThat(`a range over the largest is ${over?.status}`, over?.status === 'beyond-largest'), expectThat('a size is given beyond the largest', over?.sizeHS === null), expectNear('largest', over?.largestHS, 50), expectThat('the largest reaches the range', over.rangeKm < rangeAt({ ...request, sizeHS: largest }) * 1.001), expectThat(`the range of the largest is ${exact?.status} at ${exact?.sizeHS}`, exact?.status === 'sized' && exact.sizeHS === largest && exact.smallerHS === sizes[sizes.length - 2]), expectThat(`a fire control for 1e12 km is ${fire?.status}`, fire?.status === 'beyond-largest' && fire.sizeHS === null))
    }],
    [S.unavailable, () => {
      const request = { mode: library.SENSOR_MODES.search, targetRangeKm: 5000000, signature: 5, resolution: 10, ...stockTechs }
      const result = (extra) => library.sensorSizeForRange({ ...request, ...extra })
      const none = (what, built) => firstFailure(expectThat(`${what} is available`, !isAvailable(built)), expectThat(`${what} has a value`, valueOrNull(built) === null), expectThat(`${what} names nothing missing`, built.inputs.missing.length > 0))

      return firstFailure(expectThat('the complete request is unavailable', isAvailable(result({}))), none('no EM tech', result({ emTech: null })), none('no strength tech', result({ strengthTech: undefined })), none('no signature', result({ signature: null })), none('a signature of 0', result({ signature: 0 })), none('no resolution', result({ resolution: null })), none('no range', result({ targetRangeKm: null })), none('a range of 0', result({ targetRangeKm: 0 })), none('a jammer with no ECCM', result({ jammer: 4 })), expectThat('a jammer with its ECCM is unavailable', isAvailable(result({ jammer: 4, eccm: 2 }))), none('a missing tech in the pair', library.engagementSensorPair({ engagementRangeKm: 5000000, signature: 5, resolution: 10, strengthTech: stockTechs.strengthTech })))
    }],
    [S.pairSize, () => {
      const pair = (range) => valueOrNull(library.engagementSensorPair({ engagementRangeKm: range, signature: 50, resolution: 10, ...stockTechs }))
      const checks = [20000000, 40000000, 60000000].map((range) => {
        const { search, fireControl: fire } = pair(range)

        return firstFailure(expectNear(`${range} km: the fire control's exact size over the search sensor's`, fire.exactSizeHS / search.exactSizeHS, 0.25), expectThat(`${range} km: the search sensor is ${search.status}`, search.status === 'sized'), expectThat(`${range} km: the fire control is ${fire.status}`, fire.status === 'sized'), expectThat(`${range} km: the fire control ${fire.sizeHS} is larger than the search sensor ${search.sizeHS}`, fire.sizeHS <= search.sizeHS), expectThat(`${range} km: the search sensor does not reach it`, search.rangeKm >= range * (1 - 1e-9) && search.smallerRangeKm < range * (1 - 1e-9)), expectThat(`${range} km: the fire control does not reach it`, fire.rangeKm >= range * (1 - 1e-9) && fire.smallerRangeKm < range * (1 - 1e-9)), expectThat(`${range} km: the fire control is not a legal size`, sizes.includes(fire.sizeHS)))
      })

      return firstFailure(...checks, expectThat('the pair for 1e12 km is not beyond the largest', pair(1e12).fireControl.status === 'beyond-largest' && pair(1e12).search.status === 'beyond-largest'))
    }],
    [S.beam, () => {
      const wide = rebuilt(later, 155094)

      return firstFailure(reproduces([types.beamFireControl], SENSOR_BEAM_FIELDS, 35), expectNear('range of 155094', computedOf(wide, 'Range'), 320000), expectNear('tracking of 155094', computedOf(wide, 'Tracking'), 10150), expectNear('size of 155094', computedOf(wide, 'Size'), 4.06), expectNear('crew of 155094', computedOf(wide, 'Crew'), 16), expectNear('cost of 155094', computedOf(wide, 'Cost'), 208), expectNear('Uridium of 155094', computedOf(wide, 'Uridium'), 160), expectNear('Corbomite of 155094', computedOf(wide, 'Corbomite'), 48), expectNear('ECCM of 155094', computedOf(wide, 'ECCM'), 3), expectNear('point defence function of 154895', computedOf(rebuilt(later, 154895), 'SpecialFunction'), 1), expectNear('single weapon function of 154634', computedOf(rebuilt(stock, 154634), 'SpecialFunction'), 6), expectNear('full function of 155094', computedOf(wide, 'SpecialFunction'), 0), expectNear('single weapon size of 154634', computedOf(rebuilt(stock, 154634), 'Size'), 2.53), expectNear('crew of 154634', computedOf(rebuilt(stock, 154634), 'Crew'), 10))
    }],
    [S.limits, () => {
      const design = (extra) => library.beamFireControlDesign({ ...fireControl, ...extra })
      const capped = design({})
      const atLimit = design({ distanceRating: 350000 })
      const over = design({ distanceRating: 350001 })
      const floored = design({ rangeMultiplier: 0.1, trackingMultiplier: 0.1, distanceRating: 100000 })
      const smallest = design({ rangeMultiplier: 0.1, trackingMultiplier: 0.1, weaponNumber: 0.5 })
      const edge = design({ rangeMultiplier: 0.1, trackingMultiplier: 0.2 })
      const wider = design({ maxRangeKm: Infinity })
      const row = componentOf(modded, 500823).row
      const result = rebuilt(modded, 500823)

      return firstFailure(expectNear('range of 4 times 8,000,000', capped.rangeKm, 1400000), expectNear('range before the limit', capped.uncappedRangeKm, 32000000), expectThat('the range is not marked clamped', capped.rangeCapped === true), expectNear('Uridium follows the clamped range', capped.uridium, 700), expectNear('range at the limit', atLimit.rangeKm, 1400000), expectThat('the range at the limit is marked clamped', atLimit.rangeCapped === false), expectNear('range just over the limit', over.rangeKm, 1400000), expectThat('the range just over the limit is not marked clamped', over.rangeCapped === true), expectNear('Uridium with another limit', wider.uridium, 16000), expectNear('size of 0.1 and 0.1', floored.sizeHS, 0.01), expectThat('the floor is not marked', floored.sizeFloored === true), expectNear('size at half a weapon number', smallest.sizeHS, 0.01), expectNear('size of 0.1 and 0.2', edge.sizeHS, 0.01), expectThat('the size at the floor is marked floored', edge.sizeFloored === false), expectNear('stored floor size', row.Size, 0.01), expectNear('size of the modded 0.1 by 0.1 fire control', computedOf(result, 'Size'), 0.01), expectNear('its crew', computedOf(result, 'Crew'), 0), expectNear('its HTK', computedOf(result, 'HTK'), 0), expectVerdicts(library, result, ['Size', 'Crew', 'HTK', 'Range', 'Tracking'], 'agree'))
    }],
    [S.trunc, () => {
      const design = (extra) => library.beamFireControlDesign({ rangeMultiplier: 1, trackingMultiplier: 3.625, distanceRating: 100000, speedRating: 10000, weaponNumber: 1, hardeningRating: 100, hardeningCost: 1.5, eccmRating: 0, eccmCost: 1, ...extra })
      const stored = componentOf(stock, 154634).row

      return firstFailure(expectNear('tracking', design({}).trackingKmS, 36250), expectNear('Uridium at tracking 36250', design({}).uridium, 270), expectNear('Uridium at tracking 36999', design({ trackingMultiplier: 3.6999 }).uridium, 270), expectNear('Uridium at tracking 37000', design({ trackingMultiplier: 3.7 }).uridium, 277.5), expectNear('the stored Uridium of 154634', stored.Uridium, 33.6), expectNear('its tracking', stored.TrackingSpeed, 7590), expectThat('the stored Uridium is on the tracking in whole thousands', Math.abs(stored.Uridium - 192000 / 20000 * 7.59 * 0.5) > 1), expectVerdicts(library, rebuilt(stock, 154634), ['Uridium', 'Cost', 'Tracking'], 'agree'))
    }],
    [S.request, () => {
      const result = (extra) => library.beamFireControlForRequest({ rangeKm: 123456, trackingKmS: 4321, ...beamTechs, ...extra })
      const request = (extra) => valueOrNull(result(extra))
      const multipliers = library.FIRE_CONTROL_MULTIPLIERS
      const trackedAt = (multiplier, speedRating) => library.beamFireControlDesign({ ...beamTechs, rangeMultiplier: 1, trackingMultiplier: multiplier, speedRating }).trackingKmS
      const cases = [[123456, 4321], [50000, 13200], [320000, 20000], [28000, 5000], [1400000, 1000]].map(([rangeKm, trackingKmS]) => {
        const distance = rangeKm > 1400000 ? 400000 : rangeKm === 1400000 ? 350000 : 80000
        const value = request({ rangeKm, trackingKmS, distanceRating: distance })
        const label = `${rangeKm} km at ${trackingKmS} km/s`

        return firstFailure(expectThat(`${label} is ${value?.range?.status} and ${value?.tracking?.status}`, value?.range?.status === 'sized' && value?.tracking?.status === 'sized'), expectThat(`${label}: the range multiplier ${value.range.multiplier} does not reach it`, value.range.multiplier * distance >= rangeKm * (1 - 1e-9)), expectThat(`${label}: the range multiplier below ${value.range.smaller} reaches it`, value.range.smaller * distance < rangeKm * (1 - 1e-9)), expectThat(`${label}: the tracking multiplier ${value.tracking.multiplier} does not reach it`, trackedAt(value.tracking.multiplier, 5000) >= trackingKmS * (1 - 1e-9)), expectThat(`${label}: the tracking multiplier below ${value.tracking.smaller} reaches it`, trackedAt(value.tracking.smaller, 5000) < trackingKmS * (1 - 1e-9)), expectThat(`${label}: the multiplier below is not the one before it in the list`, value.range.smaller === multipliers[multipliers.indexOf(value.range.multiplier) - 1] && value.tracking.smaller === multipliers[multipliers.indexOf(value.tracking.multiplier) - 1]), expectThat(`${label}: the design does not reach the range`, value.design.rangeKm >= rangeKm * (1 - 1e-9) && value.design.trackingKmS >= trackingKmS * (1 - 1e-9)))
      })
      const ranges = [1250, 6250]
      const targets = Array.from({ length: 271 }, (_, index) => 130 + index).flatMap((target) => [target, target + 0.5])
      const swept = ranges.flatMap((speedRating) => targets.map((target) => {
        const value = request({ trackingKmS: target, speedRating })
        const expected = multipliers.find((multiplier) => trackedAt(multiplier, speedRating) >= target * (1 - 1e-9))
        const label = `${target} km/s on the speed rating ${speedRating}`

        if (expected === undefined) {
          return expectThat(`${label} is ${value?.tracking?.status}, not beyond the largest`, value?.tracking?.status === 'beyond-largest')
        }

        const index = multipliers.indexOf(expected)

        return firstFailure(expectThat(`${label} gives the multiplier ${value.tracking.multiplier}, not ${expected}, the smallest that stores it`, value.tracking.multiplier === expected), expectThat(`${label}: the design stores ${value.design?.trackingKmS}, short of the ${target} asked for`, value.design?.trackingKmS >= target * (1 - 1e-9)), expectThat(`${label}: the multiplier before ${multipliers[index - 1]} stores ${trackedAt(multipliers[index - 1], speedRating)}, which reaches it`, index === 0 || trackedAt(multipliers[index - 1], speedRating) < target * (1 - 1e-9)), expectThat(`${label}: the status is ${value.tracking.status}`, value.tracking.status === (index === 0 ? 'minimum-bound' : 'sized')))
      }))
      const exact = request({ rangeKm: 28000, trackingKmS: 1750 })
      const small = request({ rangeKm: 1000, trackingKmS: 100 })
      const fast = request({ trackingKmS: 30000 })
      const far = request({ rangeKm: 1500000, distanceRating: 400000 })
      const rounded = request({ trackingKmS: 138, speedRating: 1250 })
      const halfway = request({ trackingKmS: 162.5, speedRating: 1250 })
      const sources = [['an ordinary request', result({})], ['a request beyond the range limit', result({ rangeKm: 1500000, distanceRating: 400000 })], ['a request beyond the largest tracking', result({ trackingKmS: 30000 })], ['a request at the multiplier floors', result({ rangeKm: 1000, trackingKmS: 100 })]]
      const missing = result({ speedRating: null })

      return firstFailure(...cases, ...swept, expectNear('range multiplier of 28,000 km on 80,000', exact.range.multiplier, 0.35), expectNear('tracking multiplier of 1,750 km/s on 5,000', exact.tracking.multiplier, 0.35), expectThat('a request on a multiplier is not sized to it', exact.range.smaller === 0.34), expectThat(`1000 km is ${small.range.status}`, small.range.status === 'minimum-bound' && small.range.smaller === null && small.range.multiplier === 0.1), expectThat(`a tracking of 30000 is ${fast.tracking.status}`, fast.tracking.status === 'beyond-largest' && fast.design === null), expectThat(`1,500,000 km is ${far.range.status}`, far.range.status === 'beyond-largest' && far.design === null), expectNear('138 km/s on the speed rating 1250 is stored by the multiplier 0.11 (137.5 rounds to 138)', rounded.tracking.multiplier, 0.11), expectNear('the design of 0.11 on 1250', rounded.design.trackingKmS, 138), expectNear('162.5 km/s on the speed rating 1250 needs 0.14, since 0.13 stores 162', halfway.tracking.multiplier, 0.14), expectThat('the exact tracking multiplier is the unrounded ratio', Math.abs(rounded.tracking.exactMultiplier - 138 / 1250) < 1e-12), expectThat('the floored request is sized at 0.1 and 0.1', small.tracking.multiplier === 0.1 && small.design.sizeHS === 0.01 && small.design.sizeFloored === true), expectThat('a missing speed rating gives a request', !isAvailable(missing)), expectThat('a request with no speed rating is certified by the inverse sizing rule', missing.rule.id === 'design.sensorInverseSizing'), expectThat('a complete request is unavailable', isAvailable(result({}))), ...sources.map(([label, built]) => firstFailure(expectThat(`${label} is certified by ${built.rule.id}, not the inverse sizing rule`, built.rule.id === 'design.sensorInverseSizing'), expectThat(`${label} is ${built.status}, not estimated`, built.status === 'estimated'))), expectThat('the design of a request is the confirmed forward rule', result({}).value.design !== null && result({}).value.design.trackingKmS >= 4321))
    }],
    [S.roles, () => {
      const slots = (row, values) => TECH_SLOTS.forEach((slot, index) => {
        row[slot] = values[index] || 0
      })
      const base = rebuilt(modded, 500211)
      const iris = componentOf(modded, 500211).row
      const permuted = edited(modded, 500211, (_copy, component) => slots(component.row, [0, 0, 0, iris.BGTech4, iris.BGTech3, iris.BGTech2, iris.BGTech1])).result
      const twice = edited(modded, 500211, (_copy, component) => slots(component.row, [iris.BGTech1, iris.BGTech2, iris.BGTech3, iris.BGTech4, iris.BGTech4])).result
      const unnamed = edited(modded, 500211, (_copy, component) => slots(component.row, [iris.BGTech1, iris.BGTech2, 0, iris.BGTech4])).result
      const unheld = edited(modded, 500211, (copy) => {
        delete copy.techs[iris.BGTech4]
      }).result
      const lacking = edited(modded, 500211, (_copy, component) => {
        component.row.Uridium = null
        component.row.Resolution = null
      }).result
      const reasons = (result, field) => String(entryOf(result, field).reason || '')

      return firstFailure(expectThat('the permuted component computes differently', SENSOR_ACTIVE_FIELDS.every((field) => computedOf(permuted, field) === computedOf(base, field))), expectVerdicts(library, permuted, SENSOR_ACTIVE_FIELDS, 'agree'), expectVerdicts(library, twice, ['ECCM', 'Cost', 'Corbomite'], 'unknown'), expectVerdicts(library, twice, ['Strength', 'Range', 'Uridium', 'CTD'], 'agree'), expectThat('a tech of the type twice is not reported as two techs of the type', reasons(twice, 'ECCM').includes('are of type 83')), expectVerdicts(library, unnamed, ['CTD', 'Uridium', 'Cost', 'Corbomite'], 'unknown'), expectVerdicts(library, unnamed, ['Range', 'Strength', 'ECCM'], 'agree'), expectThat('a hardening tech the component does not name is read as 0', computedOf(unnamed, 'CTD') === null && computedOf(unnamed, 'Cost') === null), expectVerdicts(library, unheld, ['ECCM', 'Cost', 'Corbomite'], 'unknown'), expectVerdicts(library, unheld, ['Range', 'CTD'], 'agree'), expectThat('a tech row the save lacks is read as 0', computedOf(unheld, 'ECCM') === null), expectThat('the reason of a tech row the save lacks says so', reasons(unheld, 'ECCM').includes('no tech row')), expectVerdicts(library, lacking, ['Uridium'], 'unknown'), expectVerdicts(library, lacking, ['Range'], 'unknown'), expectThat('a figure the save lacks is read as 0', entryOf(lacking, 'Uridium').stored === null && entryOf(lacking, 'Range').computed === null))
    }],
    [S.techNumbers, () => {
      const without = (fixture, id, role, member) => edited(fixture, id, (copy) => {
        copy.techs[techOf(fixture, id, role).id][member] = null
      }).result
      const noFactor = without(stock, 154596, 'hardening', 'info2')
      const noRating = without(stock, 154596, 'hardening', 'info')
      const noEccmFactor = without(stock, 154596, 'eccm', 'info2')
      const noEccmRating = without(stock, 154596, 'eccm', 'info')
      const noStrength = without(stock, 154596, 'strength', 'info')
      const beam = without(later, 155094, 'hardening', 'info2')

      return firstFailure(expectVerdicts(library, noFactor, ['Cost', 'Uridium', 'Corbomite'], 'unknown'), expectVerdicts(library, noFactor, ['CTD', 'Range', 'Strength', 'ECCM', 'Crew', 'HTK'], 'agree'), expectThat('a cost factor the tech row lacks is read as 0', ['Cost', 'Uridium', 'Corbomite'].every((field) => computedOf(noFactor, field) === null)), expectVerdicts(library, noRating, ['CTD'], 'unknown'), expectVerdicts(library, noRating, ['Cost', 'Uridium', 'Corbomite', 'Range', 'ECCM'], 'agree'), expectThat('a rating the tech row lacks is read as 0', computedOf(noRating, 'CTD') === null), expectVerdicts(library, noEccmFactor, ['Cost', 'Corbomite'], 'unknown'), expectVerdicts(library, noEccmFactor, ['Uridium', 'ECCM', 'CTD', 'Range'], 'agree'), expectVerdicts(library, noEccmRating, ['ECCM'], 'unknown'), expectVerdicts(library, noEccmRating, ['Cost', 'Uridium', 'Corbomite', 'CTD'], 'agree'), expectVerdicts(library, noStrength, ['Strength', 'Range', 'Cost', 'Uridium', 'Corbomite'], 'unknown'), expectVerdicts(library, noStrength, ['CTD', 'ECCM', 'Crew'], 'agree'), expectThat('a strength the tech row lacks is read as 0', computedOf(noStrength, 'Strength') === null && computedOf(noStrength, 'Range') === null), expectVerdicts(library, beam, ['Uridium', 'Cost', 'Corbomite'], 'unknown'), expectVerdicts(library, beam, ['Range', 'Tracking', 'Size', 'Crew', 'HTK', 'ECCM', 'CTD', 'SpecialFunction'], 'agree'), expectThat('a cost factor the tech row of a fire control lacks is read as 0', ['Uridium', 'Cost', 'Corbomite'].every((field) => computedOf(beam, field) === null)))
    }],
    [S.descriptions, () => {
      const described = { thermal: 'Thermal Sensor Sensitivity', em: 'EM Sensor Sensitivity', strength: 'Active Sensor Strength', hardening: 'Hardening', eccm: 'ECCM', distance: 'Fire Control Distance Rating', speed: 'Fire Control Speed Rating', singleWeapon: 'Single Weapon Fire Control' }

      return firstFailure(...[...data.values()].flatMap((fixture) => Object.entries(described).map(([role, description]) => expectThat(`${fixture.label}: tech type ${roleOf[role]} (${role}) is ${fixture.techTypes[roleOf[role]]}, expected ${description}`, String(fixture.techTypes[roleOf[role]]).endsWith(description)))), expectThat('a role has no tech type', Object.keys(described).every((role) => Number.isInteger(roleOf[role]))))
    }],
    [S.explanations, () => {
      const strengthOf = techOf(modded, 500607, 'strength')
      const implied = componentOf(modded, 500607).row.ComponentValue / componentOf(modded, 500607).row.Size
      const classified = (result, field, known = [], game = 140) => library.classify(known, game, result.id, entryOf(result, field))
      const alternative = (result, field) => entryOf(result, field)?.alternative || null
      const impliedAll = edited(modded, 500607, (copy) => {
        copy.techs[strengthOf.id].info = implied
      }).result
      const tenth = edited(modded, 500208, (_copy, component) => {
        component.row.Cost *= 10
        component.row.Uridium *= 10
      }).result
      const uncapped = rebuilt(modded, 500389)
      const row = componentOf(modded, 500389).row
      const techs = Object.fromEntries(Object.entries(uncapped.roles).map(([role, tech]) => [role, tech.info]))
      const wide = library.beamFireControlDesign({ rangeMultiplier: row.FCRangeModifier, trackingMultiplier: row.FCSpeedModifier, distanceRating: techs.distance, speedRating: techs.speed, weaponNumber: techs.singleWeapon, hardeningRating: techs.hardening, hardeningCost: uncapped.roles.hardening.info2, eccmRating: techs.eccm, eccmCost: uncapped.roles.eccm.info2, maxRangeKm: Infinity })
      const lone = edited(stock, 154596, (_copy, component) => {
        component.row.ComponentValue = 2.4
      }).result
      const off = edited(stock, 154596, (_copy, component) => {
        component.row.MaxSensorRange *= 1.5
      }).result
      const moved = edited(modded, 500810, (_copy, component) => {
        component.row.Cost = 15001.2
      }).result
      const copy = clone(stock)
      const reidentified = componentOf(copy, 154596)

      reidentified.id = 900001
      reidentified.row.Cost /= 10
      reidentified.row.Uridium /= 10

      const tenthOfStock = library.reconcileSensor(copy, reidentified)
      const pinnedFigures = [[500607, 'Strength'], [500607, 'Range'], [500208, 'Cost'], [500389, 'Range'], [500389, 'Cost'], [500238, 'Cost'], [500238, 'Range'], [500608, 'Sensitivity'], [500810, 'Cost'], [500380, 'Tracking']]
      const pins = pinnedFigures.map(([id, field]) => firstFailure(expectThat(`${id} ${field} is ${classified(rebuilt(modded, id), field).verdict} with no pin, not a mismatch`, classified(rebuilt(modded, id), field).verdict === 'differ' && !classified(rebuilt(modded, id), field).reason), expectThat(`${id} ${field} is not explained by its pin`, Boolean(classified(rebuilt(modded, id), field, KNOWN_SENSOR_ROWS).reason)), expectThat(`${id} ${field} is explained by a pin of another game`, !classified(rebuilt(modded, id), field, KNOWN_SENSOR_ROWS, 138).reason)))

      return firstFailure(...pins, expectNear('strength the stored figure implies', implied, 10), expectThat('the stored strength of 500607 is the tech row', Math.abs(strengthOf.info - implied) > 1), expectVerdicts(library, impliedAll, SENSOR_ACTIVE_FIELDS, 'agree'), expectThat('the techs a stored strength implies are not diagnosed', Boolean(alternative(rebuilt(modded, 500607), 'Strength'))), expectVerdicts(library, tenth, SENSOR_PASSIVE_FIELDS, 'agree'), expectThat('a tenth of the stored cost is not diagnosed', Boolean(alternative(rebuilt(modded, 500208), 'Cost'))), expectThat('an uncapped range is not diagnosed', Boolean(alternative(uncapped, 'Range'))), expectNear('the range of the rule with no limit', wide.rangeKm, row.ComponentValue), expectNear('the Uridium of the rule with no limit at a tenth', wide.uridium / 10, row.Uridium), expectThat('a strength alone is diagnosed by the techs it implies', alternative(lone, 'Strength') === null), expectThat('a range off by 1.5 is diagnosed', alternative(off, 'Range') === null), expectThat('a strength alone is not a mismatch', classified(lone, 'Strength', KNOWN_SENSOR_ROWS, 138).verdict === 'differ' && !classified(lone, 'Strength', KNOWN_SENSOR_ROWS, 138).reason), expectThat('a range off by 1.5 is not a mismatch', classified(off, 'Range', KNOWN_SENSOR_ROWS, 138).verdict === 'differ' && !classified(off, 'Range', KNOWN_SENSOR_ROWS, 138).reason), expectThat('a changed pinned Cost is explained', classified(moved, 'Cost', KNOWN_SENSOR_ROWS).verdict === 'differ' && !classified(moved, 'Cost', KNOWN_SENSOR_ROWS).reason), expectThat('the Cost and Uridium of a stock sensor cut to a tenth are not differences', ['Cost', 'Uridium'].every((field) => library.judge(entryOf(tenthOfStock, field)) === 'differ')), expectThat('the Cost and Uridium of a stock sensor of another id cut to a tenth are explained', ['Cost', 'Uridium'].every((field) => classified(tenthOfStock, field, KNOWN_SENSOR_ROWS, 138).verdict === 'differ' && !classified(tenthOfStock, field, KNOWN_SENSOR_ROWS, 138).reason)), expectThat('the Cost and Uridium of a stock sensor cut to a tenth are not diagnosed as a tenth', ['Cost', 'Uridium'].every((field) => Boolean(alternative(tenthOfStock, field)))), expectThat('a comparison explains a difference by itself', modded.components.every((component) => library.reconcileSensor(modded, component).comparisons.every((entry) => !entry.explain))))
    }],
    [S.fixtures, () => {
      const problems = sensorFixtureProblems(library, data)

      return firstFailure(expectThat(problems.slice(0, 3).join('; ') || 'no problem', problems.length === 0), expectThat('the stock fixtures hold too few components', unmodded.reduce((total, fixture) => total + fixture.components.length, 0) >= 150), expectThat('a stock fixture lacks a kind of sensor', unmodded.every((fixture) => fixture.components.length > 0) && sizesOf(later, [types.thermal]) > 0 && sizesOf(later, [types.em]) > 0 && sizesOf(later, [types.beamFireControl]) > 0))
    }],
  ]
}

// A planted fault of the sensor and fire control rules, their loaders or the reconciliation: `find` is found once in one of the plantable files and every check named in `fails` must then fail.
const SENSOR_MUTANTS = [
  { name: 'the missile fire control given the range of a search sensor', find: 'export const MISSILE_FIRE_CONTROL_RANGE_FACTOR = 2', replace: 'export const MISSILE_FIRE_CONTROL_RANGE_FACTOR = 1', fails: [S.pair, S.pairSize, S.active] },
  { name: 'the fire control range left to the sensor range in the design', find: 'rangeKm: mode === SENSOR_MODES.missileFireControl ? searchRangeKm * MISSILE_FIRE_CONTROL_RANGE_FACTOR : searchRangeKm,', replace: 'rangeKm: searchRangeKm,', fails: [S.pair, S.active] },
  { name: 'the resolution exponent of the sensor range taken as a half', find: 'export const SENSOR_RESOLUTION_EXPONENT = 2 / 3', replace: 'export const SENSOR_RESOLUTION_EXPONENT = 0.5', fails: [S.active] },
  { name: 'the sensor range unit taken as 100,000 km', find: 'export const SENSOR_RANGE_UNIT_KM = 1000000', replace: 'export const SENSOR_RANGE_UNIT_KM = 100000', fails: [S.iris, S.active, S.inverse] },
  { name: 'the strength of a sensor taken as twice the tech times the size', find: 'const strength = strengthTech * sizeHS', replace: 'const strength = 2 * strengthTech * sizeHS', fails: [S.iris, S.active] },
  { name: 'the Uridium of a sensor taken without the hardening factor', find: 'roundHalfEven(sizeHS * strengthTech * hardeningCost, 1)', replace: 'roundHalfEven(sizeHS * strengthTech, 1)', fails: [S.iris] },
  { name: 'the crew of a sensor taken as a HS', find: 'export const SENSOR_CREW_PER_HS = 2', replace: 'export const SENSOR_CREW_PER_HS = 1', fails: [S.active, S.passive] },
  { name: 'the Uridium of a passive sensor left out', find: 'uridium: cost, crew:', replace: 'uridium: 0, crew:', fails: [S.passive] },
  { name: 'the HTK of a passive sensor always 1', find: 'htk: sizeHS < 1 ? 0 : 1, ctd: Math.trunc(hardeningRating), sizeHS, tons: sizeHS * TONS_PER_HS', replace: 'htk: 1, ctd: Math.trunc(hardeningRating), sizeHS, tons: sizeHS * TONS_PER_HS', fails: [S.passive] },
  { name: 'the resolution cut taken as the plain ratio', find: '(signature / resolution) ** 2 : 1', replace: '(signature / resolution) : 1', fails: [S.resolution] },
  { name: 'the sensor jammer cut taken on the whole jammer', find: 'SENSOR_JAMMER_BASE ** (jammer - eccm)', replace: 'SENSOR_JAMMER_BASE ** jammer', fails: [S.jammer] },
  { name: 'the sensor jammer cut taken as a base of 0.8', find: 'export const SENSOR_JAMMER_BASE = 0.75', replace: 'export const SENSOR_JAMMER_BASE = 0.8', fails: [S.jammer] },
  { name: 'the sensor jammer cut applied when the ECCM is the stronger', find: '(jammer > eccm ? SENSOR_JAMMER_BASE', replace: '(jammer < eccm ? SENSOR_JAMMER_BASE', fails: [S.jammer] },
  { name: 'the missile signature floor of 0.5', find: 'export const MISSILE_SIGNATURE_MIN = 0.3', replace: 'export const MISSILE_SIGNATURE_MIN = 0.5', fails: [S.signature] },
  { name: 'the missile signature taken as the larger of nothing and the floor', find: 'Math.max(sizeMsp / MSP_PER_HS, MISSILE_SIGNATURE_MIN)', replace: 'Math.min(sizeMsp / MSP_PER_HS, MISSILE_SIGNATURE_MIN)', fails: [S.signature] },
  { name: 'the passive detection range unit of 200,000 km', find: 'export const PASSIVE_RANGE_MULTIPLIER = 250000', replace: 'export const PASSIVE_RANGE_MULTIPLIER = 200000', fails: [S.passiveRange] },
  { name: 'the passive detection range on the sensitivity alone', find: 'Math.sqrt(sensitivity * signature) * PASSIVE_RANGE_MULTIPLIER', replace: 'Math.sqrt(sensitivity) * PASSIVE_RANGE_MULTIPLIER', fails: [S.passiveRange] },
  { name: 'the size ladder in steps of 0.2 below 2 HS', find: 'ladderOf(1, 19, 1, 10)', replace: 'ladderOf(2, 18, 2, 10)', fails: [S.ladders] },
  { name: 'the size ladder short of 4.75 HS', find: 'ladderOf(200, 475, 25, 100)', replace: 'ladderOf(200, 450, 25, 100)', fails: [S.ladders] },
  { name: 'the resolution ladder short of 500', find: 'ladderOf(220, 500, 20, 1)', replace: 'ladderOf(220, 480, 20, 1)', fails: [S.ladders] },
  { name: 'the multiplier ladder without 4', find: '...ladderOf(10, 399, 1, 100), 4])', replace: '...ladderOf(10, 399, 1, 100)])', fails: [S.ladders] },
  { name: 'a range met only above the wanted one', find: 'rangeKm >= wantedKm * (1 - SENSOR_RANGE_TOLERANCE)', replace: 'rangeKm > wantedKm', fails: [S.inverse] },
  { name: 'the range tolerance of 1e-3', find: 'const SENSOR_RANGE_TOLERANCE = 1e-9', replace: 'const SENSOR_RANGE_TOLERANCE = 1e-3', fails: [S.inverse] },
  { name: 'the smallest legal size sized and not reported as the minimum', find: "const status = found.index === 0 ? 'minimum-bound' : 'sized'", replace: "const status = 'sized'", fails: [S.minimum] },
  { name: 'a range beyond the largest sized as the largest', find: "if (found.index < 0) {\n    return ofRule({ rule, value: { status: 'beyond-largest', sizeHS: null", replace: "if (false) {\n    return ofRule({ rule, value: { status: 'beyond-largest', sizeHS: null", fails: [S.beyond] },
  { name: 'the exact size of a sensor not squared', find: '(targetRangeKm / factor / SENSOR_RANGE_UNIT_KM) ** 2 * SENSOR_PI', replace: '(targetRangeKm / factor / SENSOR_RANGE_UNIT_KM) * SENSOR_PI', fails: [S.inverse, S.pairSize] },
  { name: 'the fire control of a pair sized as a search sensor', find: 'fireControl: sensorSizeForRange({ ...request, mode: SENSOR_MODES.missileFireControl })', replace: 'fireControl: sensorSizeForRange({ ...request, mode: SENSOR_MODES.search })', fails: [S.pairSize] },
  { name: 'a sizing request that needs no EM sensitivity tech', find: "['EM sensitivity tech', emTech, POSITIVE, 'the EM sensitivity tech above zero'],", replace: '', fails: [S.unavailable] },
  { name: 'a fire control request that needs no speed rating tech', find: "['speed rating tech', speedRating, POSITIVE, 'the fire control speed rating tech above zero'],", replace: '', fails: [S.request] },
  { name: 'a fire control request over the limit sized', find: 'const range = rangeKm > BEAM_FIRE_CONTROL_MAX_RANGE_KM ?', replace: 'const range = false ?', fails: [S.request] },
  { name: 'a fire control range multiplier met only above the wanted range', find: 'multiplier * distanceRating >= rangeKm * (1 - SENSOR_RANGE_TOLERANCE)', replace: 'multiplier * distanceRating > rangeKm', fails: [S.request] },
  { name: 'a fire control tracking multiplier chosen from the unrounded ratio', find: 'fireControlTracking(multiplier, speedRating) >= trackingKmS * (1 - SENSOR_RANGE_TOLERANCE)', replace: 'multiplier * speedRating >= trackingKmS * (1 - SENSOR_RANGE_TOLERANCE)', fails: [S.request] },
  { name: 'a fire control request certified by the confirmed forward rule', find: "const rule = SENSOR_RULES.sizing\n  const { present, missing } = sensorInputs([\n    ['wanted range', rangeKm, POSITIVE, 'the range wanted, above zero'],\n    ['wanted tracking", replace: "const rule = SENSOR_RULES.beam\n  const { present, missing } = sensorInputs([\n    ['wanted range', rangeKm, POSITIVE, 'the range wanted, above zero'],\n    ['wanted tracking", fails: [S.request] },
  { name: 'the fire control range limit of 1,500,000 km', find: 'export const BEAM_FIRE_CONTROL_MAX_RANGE_KM = 1400000', replace: 'export const BEAM_FIRE_CONTROL_MAX_RANGE_KM = 1500000', fails: [S.limits, S.request] },
  { name: 'the fire control range not limited', find: 'Math.min(maxRangeKm, uncappedRangeKm)', replace: 'uncappedRangeKm', fails: [S.limits] },
  { name: 'the fire control cost on the range before the limit', find: 'roundHalfEven(rangeKm / BEAM_FIRE_CONTROL_KM_PER_COST_UNIT', replace: 'roundHalfEven(uncappedRangeKm / BEAM_FIRE_CONTROL_KM_PER_COST_UNIT', fails: [S.limits] },
  { name: 'the fire control size floor of 0.02', find: 'export const BEAM_FIRE_CONTROL_MIN_SIZE_HS = 0.01', replace: 'export const BEAM_FIRE_CONTROL_MIN_SIZE_HS = 0.02', fails: [S.limits] },
  { name: 'the fire control size not floored', find: 'Math.max(BEAM_FIRE_CONTROL_MIN_SIZE_HS, roundedSizeHS)', replace: 'roundedSizeHS', fails: [S.limits] },
  { name: 'the tracking of a fire control cost rounded and not cut', find: 'Math.floor(trackingKmS / BEAM_FIRE_CONTROL_TRACKING_COST_STEP)', replace: 'Math.round(trackingKmS / BEAM_FIRE_CONTROL_TRACKING_COST_STEP)', fails: [S.trunc, S.beam] },
  { name: 'the tracking of a fire control cost not cut', find: 'Math.floor(trackingKmS / BEAM_FIRE_CONTROL_TRACKING_COST_STEP)', replace: '(trackingKmS / BEAM_FIRE_CONTROL_TRACKING_COST_STEP)', fails: [S.trunc, S.beam] },
  { name: 'the fire control cost step of 500', find: 'export const BEAM_FIRE_CONTROL_TRACKING_COST_STEP = 1000', replace: 'export const BEAM_FIRE_CONTROL_TRACKING_COST_STEP = 500', fails: [S.trunc, S.beam] },
  { name: 'the fire control cost range unit of 10,000 km', find: 'export const BEAM_FIRE_CONTROL_KM_PER_COST_UNIT = 20000', replace: 'export const BEAM_FIRE_CONTROL_KM_PER_COST_UNIT = 10000', fails: [S.beam, S.trunc] },
  { name: 'the fire control Uridium without the hardening factor', find: 'hardeningCost * weaponNumber, 1)', replace: 'weaponNumber, 1)', fails: [S.trunc] },
  { name: 'the fire control size rounded to a tenth', find: 'trackingMultiplier / 2 * weaponNumber, 2)', replace: 'trackingMultiplier / 2 * weaponNumber, 1)', fails: [S.beam] },
  { name: 'the fire control size not halved', find: 'rangeMultiplier * trackingMultiplier / 2 * weaponNumber', replace: 'rangeMultiplier * trackingMultiplier * weaponNumber', fails: [S.beam] },
  { name: 'the crew of a fire control of 2 a HS', find: 'export const FIRE_CONTROL_CREW_PER_HS = 4', replace: 'export const FIRE_CONTROL_CREW_PER_HS = 2', fails: [S.beam] },
  { name: 'the point defence tracking of 3', find: 'export const BEAM_FIRE_CONTROL_POINT_DEFENCE_TRACKING = 4', replace: 'export const BEAM_FIRE_CONTROL_POINT_DEFENCE_TRACKING = 3', fails: [S.beam] },
  { name: 'the single weapon function of 5', find: 'singleWeapon: 6 })', replace: 'singleWeapon: 5 })', fails: [S.beam] },
  { name: 'a single weapon told by a weapon number of 1 or less', find: 'specialFunction: weaponNumber < 1 ?', replace: 'specialFunction: weaponNumber <= 1 ?', fails: [S.beam] },
  { name: 'the sensor strength tech read as type 21', find: 'em: 125, strength: 20,', replace: 'em: 125, strength: 21,', fails: [S.descriptions, S.iris] },
  { name: 'the thermal sensitivity tech read as type 20', find: 'thermal: 19, em: 125', replace: 'thermal: 20, em: 125', fails: [S.descriptions, S.passive] },
  { name: 'two techs of one type not ambiguous', find: 'if (found.length > 1) {', replace: 'if (false) {', fails: [S.roles] },
  { name: 'a tech the save lacks not unresolved', find: 'if (unknown.length) {\n    return { state: \'unresolved\'', replace: 'if (false) {\n    return { state: \'unresolved\'', fails: [S.roles] },
  { name: 'the techs of a component read by the first four slots only', find: 'fixture.techs[entry.id] && fixture.techs[entry.id].type === type)', replace: "fixture.techs[entry.id] && fixture.techs[entry.id].type === type && entry.slot < 'BGTech5')", fails: [S.roles] },
  { name: 'a figure the save lacks read as 0', find: 'const knownFigure = (value) => (isKnown(value) && Number.isFinite(value) ? value : null)', replace: 'const knownFigure = (value) => (isKnown(value) && Number.isFinite(value) ? value : 0)', fails: [S.roles] },
  { name: 'the tenth of the stored cost taken as a fifth in the diagnosis', find: 'const COST_SCALE_TENTH = 0.1', replace: 'const COST_SCALE_TENTH = 0.2', fails: [S.explanations] },
  { name: 'a tech implied by one figure diagnosed with nothing to corroborate it', find: 'const corroborated = !attempt.roles.length ||', replace: 'const corroborated = true ||', fails: [S.explanations] },
  { name: 'a difference explained by the alternative that fits it', find: 'alternative: alternatives.get(item.entry.name) || null', replace: 'explain: alternatives.get(item.entry.name) || null', fails: [S.explanations, S.fixtures] },
  { name: 'a cost factor a tech row lacks read as 0', find: 'const info2 = finite(found.info2) ? found.info2 : NaN', replace: 'const info2 = finite(found.info2) ? found.info2 : 0', fails: [S.techNumbers] },
  { name: 'a rating a tech row lacks read as 0', find: 'const info = finite(found.info) ? found.info : NaN', replace: 'const info = finite(found.info) ? found.info : 0', fails: [S.techNumbers] },
  { name: 'the Uridium of an active sensor needing the hardening rating', find: "field('Uridium', 'Uridium', 'decimal', ['size', 'strength', 'hardeningCost'], (design) => design.uridium", replace: "field('Uridium', 'Uridium', 'decimal', ['size', 'strength', 'hardening'], (design) => design.uridium", fails: [S.techNumbers] },
]

const ALL_MUTANTS = [...MISSILE_MUTANTS, ...SENSOR_MUTANTS]

// What a planted fault can change: the rules and the loaders of the utilities and the reconciliation of scripts/lib. `UTILITY_CLOSURE` is every utility the first two load, copied with them so the mutant loads on its own.
const PLANTABLE = [{ name: 'design-rules', directory: UTILITIES }, { name: 'design-data', directory: UTILITIES }, { name: 'missile-reconcile', directory: MISSILE_LIBRARY }, { name: 'sensor-reconcile', directory: MISSILE_LIBRARY }]
const UTILITY_CLOSURE = ['design-rules', 'design-data', 'provenance', 'tank-packing', 'missile-hit', 'capabilities', 'capability-reads']

// Copies the utilities and the reconciliation into a temporary folder with `replace` in place of `find`, which must be found once in one of the files that can be planted. Returns the folder and the two folders to load from.
const plantedFault = (find, replace) => {
  const holders = PLANTABLE.map((file) => ({ ...file, source: fs.readFileSync(path.join(file.directory, `${file.name}.js`), 'utf8') })).filter(({ source }) => source.includes(find))

  if (holders.length !== 1) {
    throw new Error(`the text to cut is in ${holders.length} files, not one`)
  }

  const found = holders[0].source.split(find).length - 1

  if (found !== 1) {
    throw new Error(`the text to cut is found ${found} times, not once`)
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-missile-mutant-'))
  const utilities = path.join(root, 'utilities')
  const library = path.join(root, 'lib')

  fs.mkdirSync(utilities)
  fs.mkdirSync(library)

  for (const { name, directory, target } of [...UTILITY_CLOSURE.map((name) => ({ name, directory: UTILITIES, target: utilities })), { name: 'missile-reconcile', directory: MISSILE_LIBRARY, target: library }, { name: 'sensor-reconcile', directory: MISSILE_LIBRARY, target: library }]) {
    const source = fs.readFileSync(path.join(directory, `${name}.js`), 'utf8')

    fs.writeFileSync(path.join(target, `${name}.js`), holders[0].name === name ? source.replace(find, () => replace) : source)
  }

  return { root, utilities, library }
}

// One planted fault on its own copy of the rules, loaders and reconciliation, loaded from a temporary folder that is removed after, with only the checks it names run. The result is { status: 'caught' | 'survived' | 'not run', message }: caught when each named check fails.
const tryMutant = async ({ find, replace, fails }, data, sensorData) => {
  let planted = null

  try {
    planted = plantedFault(find, replace)

    const library = await loadMissileLibrary(planted)
    const named = [...missileChecks(library, data), ...sensorChecks(library, sensorData)].filter(([checkName]) => fails.includes(checkName))
    const absent = fails.filter((start) => !named.some(([checkName]) => checkName === start))
    const passing = named.filter(([, test]) => outcome(test) === true).map(([checkName]) => checkName)

    if (absent.length || passing.length) {
      return { status: 'survived', message: absent.length ? `no check is named ${absent.join('; ')}` : `these checks still pass: ${passing.join('; ')}` }
    }

    return { status: 'caught', message: `${named.length} named checks fail` }
  } catch (error) {
    return { status: 'not run', message: error.message }
  } finally {
    if (planted) {
      fs.rmSync(planted.root, { recursive: true, force: true })
    }
  }
}

// A mutant in a process of its own: the loader of the utilities imports modules from data URLs made of their source, so two copies of an unchanged utility in one process are one module with one rule registry, and a fault that changes what is registered would reach the checks that follow it. A process that dies with no result is a mutant that did not run.
const mutantInProcess = async (name) => {
  const { code, stdout, stderr } = await runChild(__filename, ['--run-mutant', name])

  try {
    return JSON.parse(stdout.trim().split('\n').pop())
  } catch {
    return { status: 'not run', message: `the process exited with ${code} and no result: ${(stderr || stdout).trim().slice(0, 400)}` }
  }
}

// Every mutant in a process of its own, as many at a time as the pool allows; resolves the results in the order of the list.
const startMutants = () => inParallel(ALL_MUTANTS, ({ name }) => mutantInProcess(name), jobs())

// Prints the results in the order of the list. A mutant is caught when each check it names fails.
const printMutants = (results) => {
  let caught = 0

  results.forEach((result, index) => {
    const { name } = ALL_MUTANTS[index]
    const { status, message } = result instanceof Error ? { status: 'not run', message: result.message } : result

    if (status === 'caught') {
      caught++
      console.log(`mutant caught: ${name}: ${message}`)
    } else {
      console.log(`${status === 'survived' ? 'MUTANT SURVIVED' : 'MUTANT NOT RUN'}: ${name}: ${message}`)
    }
  })

  return { caught, missed: ALL_MUTANTS.length - caught }
}

// The reports of the fixtures, the checks of the rules and the mutants of the library, with no save. The exit code is 1 when a report has a mismatch, a check fails or a mutant survives.
const runFixtures = async () => {
  const data = loadFixtures()
  const sensorData = loadSensorFixtures()
  const library = await loadMissileLibrary()
  const pending = startMutants()
  const registry = () => JSON.stringify(library.provenance.listRules())
  const registryBefore = registry()
  const totals = { checked: 0, mismatches: 0, explained: 0, unsupported: 0, unknown: 0, resolved: 0 }

  for (const fixture of data.values()) {
    const report = reconcileFixture(library, fixture, `fixture ${fixture.label} (${fixture.save}, game ${fixture.game}; ${fixture.scope}): ${fixture.note}`, { ruleIds: [] })

    report.print(null)
    totals.checked += report.checked
    totals.mismatches += report.mismatches.length
    totals.explained += report.explained.length
    totals.unsupported += report.unsupported.length
    totals.unknown += report.unknown.length
    totals.resolved += report.resolvedFromStored
  }

  const sensorTotals = { checked: 0, mismatches: 0, explained: 0, unsupported: 0, unknown: 0, resolved: 0 }

  for (const fixture of sensorData.values()) {
    const report = reconcileSensorFixture(library, fixture, `fixture ${fixture.label} (${fixture.save}, game ${fixture.game}; ${fixture.scope}): ${fixture.note}`, { ruleIds: [] })

    report.print(null)
    sensorTotals.checked += report.checked
    sensorTotals.mismatches += report.mismatches.length
    sensorTotals.explained += report.explained.length
    sensorTotals.unsupported += report.unsupported.length
    sensorTotals.unknown += report.unknown.length
    sensorTotals.resolved += report.resolvedFromStored
  }

  let failedChecks = 0
  const checks = [...missileChecks(library, data), ...sensorChecks(library, sensorData)]

  for (const [name, test] of checks) {
    const result = outcome(test)

    if (result !== true) {
      failedChecks++
    }

    console.log(result === true ? `check passed: ${name}` : `CHECK FAILED: ${name}: ${result}`)
  }

  const mutants = printMutants(await pending)
  const registryAfter = registry()
  const registrySame = registryBefore === registryAfter

  console.log(registrySame ? 'check passed: the rule registry of the checks is the same after the checks and the mutants' : 'CHECK FAILED: the rule registry of the checks is not the same after the checks and the mutants: a check or a mutant registered or changed a rule of the shared registry')
  console.log(`fixtures: ${data.size}, ${totals.checked} compared, ${totals.mismatches} mismatches, ${totals.explained} explained, ${totals.unsupported} unsupported, ${totals.unknown} unknown; ${totals.resolved} of the compared resolved from the stored figure`)
  console.log(`sensor fixtures: ${sensorData.size}, ${sensorTotals.checked} compared, ${sensorTotals.mismatches} mismatches, ${sensorTotals.explained} explained, ${sensorTotals.unsupported} unsupported, ${sensorTotals.unknown} unknown; ${sensorTotals.resolved} of the compared resolved from the stored figure`)
  console.log(`checks: ${checks.length + 1 - failedChecks - (registrySame ? 0 : 1)} of ${checks.length + 1} pass; mutants: ${mutants.caught} of ${ALL_MUTANTS.length} caught`)

  return totals.mismatches || sensorTotals.mismatches || failedChecks || !registrySame || mutants.missed ? 1 : 0
}

const CHECKS = { engine: checkEngines, speed: checkSpeeds, range: checkRanges, jump: checkJumpDrives, maintenance: checkMaintenance, missile: checkMissiles, sensor: checkSensors }

const main = async () => {
  const options = parseArguments(process.argv.slice(2))

  if (options.mutant !== null) {
    const mutant = ALL_MUTANTS.find(({ name }) => name === options.mutant)

    if (!mutant) {
      fail(`No planted fault named ${options.mutant}`)
    }

    console.log(JSON.stringify(await tryMutant(mutant, loadFixtures(), loadSensorFixtures())))
    process.exit(0)
  }

  if (options.fixtures) {
    process.exit(await runFixtures())
  }

  const database = await open(path.resolve(options.save)).catch((error) => fail(`Cannot open the save: ${error.message}`))
  const [race] = await all(database, 'select RaceID, GameID, RaceName from FCT_Race where RaceID = :race', { ':race': options.race })

  if (!race) {
    fail(`The save has no race ${options.race}`)
  }

  const rules = await loadRules()
  const techs = new Map((await all(database, 'select TechSystemID, TechTypeID, AdditionalInfo, AdditionalInfo2 from FCT_TechSystem')).map((row) => [row.TechSystemID, row]))
  const context = { database, rules, techs, parameters: { ':game': race.GameID, ':race': race.RaceID }, allGame: options.allGame, ledger: options.ledger, library: await loadMissileLibrary() }

  if (options.exportFile || options.sensorExportFile) {
    const saved = options.sensorExportFile ? await exportSensorFixture(context, options) : await exportMissileFixture(context, options)

    database.close()
    console.log(options.sensorExportFile ? `${saved.components} components and ${saved.techs} techs written to fixture "${options.label}" in ${options.sensorExportFile}` : `${saved.designs} designs, ${saved.races} races, ${saved.components} engines written to fixture "${options.label}" in ${options.exportFile}`)
    process.exit(0)
  }

  console.log(`${path.basename(options.save)}: race ${race.RaceID} "${race.RaceName}", game ${race.GameID}`)

  let mismatches = 0
  let explained = 0
  let unsupported = 0
  let unknown = 0
  let resolved = 0

  const covered = new Set()

  for (const rule of options.rules) {
    const report = await CHECKS[rule](context)

    report.print(rules.registry)
    report.ruleIds.forEach((id) => covered.add(id))
    mismatches += report.mismatches.length
    explained += report.explained.length
    unsupported += (report.unsupported || []).length
    unknown += (report.unknown || []).length
    resolved += report.resolvedFromStored || 0
  }

  const unchecked = rules.registry.listRules().filter((rule) => !covered.has(rule.id))

  if (unchecked.length) {
    console.log(`registered rules no check here covers: ${unchecked.map((rule) => `${rule.id} (${rule.verification})`).join(', ')}`)
  }

  database.close()
  console.log(`${mismatches} mismatches, ${explained} explained${unsupported ? `, ${unsupported} unsupported` : ''}${unknown ? `, ${unknown} unknown` : ''}${resolved ? `, ${resolved} resolved from the stored figure` : ''}`)
  process.exit(mismatches ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
