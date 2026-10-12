/*
  Checks the planners' design rules (src/renderer/utilities/design-rules.js) against a save: every stored engine, class speed, class range input and jump drive of one race is recomputed from the tech rows it was designed with and compared with what the game wrote.

  node scripts/check-design-rules.js <save.db> --race <RaceID> [--rules engine,speed,range,jump] [--all-game]

  Zero mismatches means the rules reproduce every stored row. A row the rules cannot reproduce for a reason outside them (a modded tech, a missing tech row, a design made under older rules) is counted as explained, with its reason; any other difference is a mismatch and sets exit code 1. The race's components are the FCT_ShipDesignComponents rows of its game that it holds through FCT_RaceTech (TechID = SDComponentID), the way the Propulsion Planner selects them; --all-game checks every component of the game instead, other races' designs included. Each check is printed under the id, verification and game versions of the rules it checks, read from the rule registry (utilities/provenance.js, filled by design-rules.js), and a registered rule that no check run covers is listed at the end. The save is opened read-only through the same sqlite3 module the app uses.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')

const RULES = ['engine', 'speed', 'range', 'jump']

// The registered rules whose formulas each check compares with stored values. The range check compares only the stored fuel efficiency with the class's engines, an input of the burn and range formulas, so it names no rule: design.burnPerHour and design.fullPowerRangeKm stay in the list of rules no check covers.
const RULE_IDS = { engine: ['design.engineDesign'], speed: ['design.classSpeed'], range: [], jump: ['design.jumpDriveDesign'] }
const INPUT_ONLY = { range: 'input check only: the stored fuel efficiency against the class\'s engines; the burn and range formulas are not compared with a stored value' }
const RELATIVE_TOLERANCE = 1e-6
const ABSOLUTE_TOLERANCE = 1e-9
const NAMED_CLASSES = [64475, 62944]

// Rows the rules cannot reproduce for a reason outside them, each checked by hand against the saves. A key is rule:id:field. Nothing else is explained away: a difference not listed here and not matched by a pattern in engineExplainer or jumpExplainer is a mismatch.
const KNOWN_ROWS = {
  'engine:500260:cost': "the stored cost is a tenth of the rule's 1500; the sample's other engines on the same thermal tech (500722, 500735, 500606) match the rule, so this cost was changed outside the design rule",
  'engine:500613:military': "a 0.8 HS engine at thrust 0.9 is military under the rule (commercial needs 25 HS and thrust 0.5 or less); the flag was changed outside the design rule, and the sample's commercial engines (500246, 500707, 500708) obey it",
}

const fail = (message) => {
  console.error(message)
  process.exit(2)
}

const parseArguments = (argv) => {
  const options = { save: null, race: null, rules: RULES, allGame: false }

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]

    if (argument === '--race') {
      options.race = Number(argv[++index])
    } else if (argument === '--rules') {
      options.rules = String(argv[++index]).split(',').map((rule) => rule.trim()).filter(Boolean)
    } else if (argument === '--all-game') {
      options.allGame = true
    } else if (argument.startsWith('--')) {
      fail(`Unknown option ${argument}`)
    } else {
      options.save = argument
    }
  }

  if (!options.save || !Number.isInteger(options.race)) {
    fail('Usage: node scripts/check-design-rules.js <save.db> --race <RaceID> [--rules engine,speed,range,jump] [--all-game]')
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

  return { ...rules, registry }
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
    const same = kind === 'decimal' ? close(Number(stored), Number(computed)) : Number(stored) === Number(computed)

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

  print (registry) {
    console.log(`${this.rule} [${this.describeRules(registry)}]: ${this.checked} checked, ${this.mismatches.length} mismatches, ${this.explained.length} explained`)

    for (const note of this.notes) {
      console.log(`  note: ${note}`)
    }

    for (const entry of this.mismatches) {
      console.log(`  MISMATCH ${entry.id} "${entry.name}" ${entry.field}: stored ${entry.stored}, computed ${entry.computed}`)
    }

    for (const entry of this.explained) {
      console.log(`  explained ${entry.id} "${entry.name}" ${entry.field}: stored ${entry.stored}, computed ${entry.computed} - ${entry.reason}`)
    }
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

const CHECKS = { engine: checkEngines, speed: checkSpeeds, range: checkRanges, jump: checkJumpDrives }

const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  const database = await open(path.resolve(options.save)).catch((error) => fail(`Cannot open the save: ${error.message}`))
  const [race] = await all(database, 'select RaceID, GameID, RaceName from FCT_Race where RaceID = :race', { ':race': options.race })

  if (!race) {
    fail(`The save has no race ${options.race}`)
  }

  const rules = await loadRules()
  const techs = new Map((await all(database, 'select TechSystemID, TechTypeID, AdditionalInfo, AdditionalInfo2 from FCT_TechSystem')).map((row) => [row.TechSystemID, row]))
  const context = { database, rules, techs, parameters: { ':game': race.GameID, ':race': race.RaceID }, allGame: options.allGame }

  console.log(`${path.basename(options.save)}: race ${race.RaceID} "${race.RaceName}", game ${race.GameID}`)

  let mismatches = 0
  let explained = 0

  const covered = new Set()

  for (const rule of options.rules) {
    const report = await CHECKS[rule](context)

    report.print(rules.registry)
    report.ruleIds.forEach((id) => covered.add(id))
    mismatches += report.mismatches.length
    explained += report.explained.length
  }

  const unchecked = rules.registry.listRules().filter((rule) => !covered.has(rule.id))

  if (unchecked.length) {
    console.log(`registered rules no check here covers: ${unchecked.map((rule) => `${rule.id} (${rule.verification})`).join(', ')}`)
  }

  database.close()
  console.log(`${mismatches} mismatches, ${explained} explained`)
  process.exit(mismatches ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
