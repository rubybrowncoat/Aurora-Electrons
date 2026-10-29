/*
  Checks the Sorium harvester rule against a save: for every harvester ship of one race it recomputes the annual potential and the fuel one harvesting step can add from the save's own rows, compares the stored inputs it can (the racial rate, the class module and tank totals, the deposit accessibility, the tank level) and compares the Fuel & Maintenance page's own figures (utilities/logistics.js harvesterReport, harvesterBasis, harvesterObtainable and harvesterAdminBonus, fed by the page's own query) with the rule.

  node scripts/check-harvesters.js <save.db> --race <RaceID> [--years <n>] [--since <earlier.db>] [--list]

  Two kinds of result stay apart. Rule verification: the rule below is the game's 2.7.1 per-step harvesting rule, read from its source (docs/plans/backlog/evidence/AE-079-01.md § 2); the worked cases at the end run it on in-memory rows and the stored-input checks compare it with what the game wrote. Observed reconciliation: --since reads an earlier save of the same 2.7 campaign and replays the construction cycles between the two from the increment ledger, to see whether a ship's fuel gain is what the rule predicts; a ship that moved, or whose tank is full, or that cannot be told from a transfer, gives no clean observation, and when none is clean the check says so.

  A stored value the rule does not reproduce, a page figure that differs from the rule, and a worked case that fails are mismatches and set exit code 1. The page follows the rule on the undamaged module and tank counts, the body found by coordinates, any room in the tanks, the root command for a fleet without one, and an unknown output where the body is unsurveyed, so no page difference is explained away: the explained classes that remain are only the stored-input ones (a deposit raised outside the game, fuel above the capacity of damaged tanks).

  --years sets the horizon of the obtainable-output column (default 1). --list prints one line per ship. Read-only: the save is opened read-only and nothing is written.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { fuelServiceTruth } = require('./lib/fuel-service-oracle')

// Game constants of the rule: component type ids (harvester, fuel storage), the Sorium material id, the commander's Mining bonus id, the ship command type, body types that can be harvested, the race type of the Ancients, litres per tonne of Sorium and seconds per year, and the racial rate a race has before it researches a better one.
const HARVESTER_TYPE = 32
const FUEL_STORAGE_TYPE = 3
const SORIUM = 8
const MINING_BONUS = 6
const SHIP_COMMAND = 1
const GAS_BODY_TYPES = [4, 5]
const ANCIENTS = 6
const FUEL_RACIAL_RATE_TECH_TYPE = 32
const BASE_RACIAL_RATE = 40000
const LITRES_PER_TON = 2000
const SECONDS_PER_YEAR = 31536000
const RELATIVE_TOLERANCE = 1e-9
const ABSOLUTE_TOLERANCE = 1e-6
const SHAPE_COLUMNS = ['AllowCMC', 'AncientRelics']
const APP_RULES = ['logistics.harvesterOutput', 'logistics.harvesterObtainable']
const FORMULA_VERSION = '2.7.x'

const fail = (message) => {
  console.error(message)
  process.exit(2)
}

const parseArguments = (argv) => {
  const options = { save: null, race: null, years: 1, since: null, list: false }

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]

    if (argument === '--race') {
      options.race = Number(argv[++index])
    } else if (argument === '--years') {
      options.years = Number(argv[++index])
    } else if (argument === '--since') {
      options.since = argv[++index]
    } else if (argument === '--list') {
      options.list = true
    } else if (argument.startsWith('--')) {
      fail(`Unknown option ${argument}`)
    } else {
      options.save = argument
    }
  }

  if (!options.save || !Number.isInteger(options.race) || !(options.years > 0)) {
    fail('Usage: node scripts/check-harvesters.js <save.db> --race <RaceID> [--years <n>] [--since <earlier.db>] [--list]')
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

const loadApp = async () => {
  const { logistics, minerals, crew, 'naval-admins': navalAdmins, provenance: registry, 'design-rules': designRules, 'fuel-donors': fuelDonors } = await loadUtilities(['logistics', 'minerals', 'crew', 'naval-admins', 'provenance', 'design-rules', 'fuel-donors'])

  return { ...logistics, crewFraction: crew.crewFraction, navalAdminChainBonus: minerals.navalAdminChainBonus, loadNavalAdmins: navalAdmins.loadNavalAdmins, registry, roundHalfEven: designRules.roundHalfEven, fuelDonors }
}

// The page's own harvesters query, read from its source so the check compares what the page runs, not a copy of it.
const pageQuery = (game, race) => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'renderer', 'pages', 'logistics.vue'), 'utf8')
  const match = source.match(/database\.query\(`(select FCT_Fleet\.FleetID, FCT_Fleet\.FleetName, FCT_Fleet\.ParentCommandID as NavalAdminCommandID[^`]*)`\)/)

  if (!match) {
    throw new Error('pages/logistics.vue no longer holds the harvesters query this check reads; update the pageQuery pattern')
  }

  const sql = match[1].replace(/\$\{this\.GameID\}/g, String(game)).replace(/\$\{this\.RaceID\}/g, String(race))

  if (sql.includes('${')) {
    throw new Error('The harvesters query of pages/logistics.vue has a placeholder this check does not fill')
  }

  return sql
}

const close = (a, b) => Math.abs(a - b) <= Math.max(ABSOLUTE_TOLERANCE, RELATIVE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b)))

const format = (value) => (typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(10)) : value)

// The rule. `modules` are the undamaged harvester modules, `rate` the racial litres per module and year, `commander` the ship commander's Mining bonus (1 without one), `admin` the naval admin chain's multiplier, `accessibility` the deposit's (null when unknown).

// A module-count share: the game scales by crew only while the crew is below the class's, and never above 1.
const crewFraction = (crew, classCrew) => (crew < classCrew ? crew / classCrew : 1)

// Litres a year with the tanks unconstrained: null while the accessibility is unknown, never 0.
const annualPotential = ({ modules, rate, commander, admin, crew, classCrew, accessibility }) => (accessibility === null ? null : modules * rate * commander * crewFraction(crew, classCrew) * accessibility * admin)

// One harvesting step of `years`, in the order the game applies it: a ship with no undamaged module or no room does nothing (room is capacity minus fuel, strictly positive), the step is capped by the Sorium left in tonnes times 2,000 and then by the room. `perYear` and `depositTons` may be null: the step is then unknown, not 0.
const harvestStep = ({ modules, fuel, capacity, perYear, depositTons }, years) => {
  if (!(modules > 0)) {
    return { litres: 0, limit: 'no undamaged module' }
  }

  if (!(fuel < capacity)) {
    return { litres: 0, limit: 'tanks full' }
  }

  if (perYear === null || depositTons === null) {
    return { litres: null, limit: 'unknown' }
  }

  const room = capacity - fuel
  const wanted = perYear * years

  if (!(depositTons > 0)) {
    return { litres: 0, limit: 'no Sorium' }
  }

  const litres = Math.min(wanted, depositTons * LITRES_PER_TON, room)

  return { litres, limit: litres === room ? 'tank room' : litres === depositTons * LITRES_PER_TON ? 'deposit' : 'rate' }
}

// The accessibility the game writes after a deposit falls below half its original amount (rounded half to even to 2 decimals).
const declinedAccessibility = (roundHalfEven, { amount, half, original }) => roundHalfEven((original - 0.1) * (amount / half) + 0.1, 2)

class Report {
  constructor (title, ruleIds = [], scope = '') {
    this.title = title
    this.ruleIds = ruleIds
    this.scope = scope
    this.checked = 0
    this.same = 0
    this.mismatches = []
    this.explained = []
    this.notes = []
  }

  // `kind`: 'decimal' (tolerance) or 'exact'. A difference is explained when `explain()` gives a reason, otherwise it is a mismatch.
  compare (row, field, stored, computed, kind, explain) {
    this.checked++

    if (kind === 'decimal' ? close(Number(stored), Number(computed)) : stored === computed) {
      this.same++
      return
    }

    const entry = { id: row.id, name: row.name, field, stored: format(stored), computed: format(computed) }
    const reason = explain ? explain() : null

    if (reason) {
      this.explained.push({ ...entry, reason })
    } else {
      this.mismatches.push(entry)
    }
  }

  print (registry) {
    const rules = this.ruleIds.length ? this.ruleIds.map((id) => {
      const rule = registry.getRule(id)

      return rule ? `${id}: ${rule.verification}, game ${rule.versions.join(', ')}` : `${id}: not registered`
    }).join('; ') : this.scope

    console.log(`${this.title} [${rules}]: ${this.checked} checked, ${this.same} equal, ${this.explained.length} explained, ${this.mismatches.length} mismatches`)

    for (const note of this.notes) {
      console.log(`  note: ${note}`)
    }

    for (const entry of this.mismatches) {
      console.log(`  MISMATCH ${entry.id} "${entry.name}" ${entry.field}: stored ${entry.stored}, computed ${entry.computed}`)
    }

    const reasons = new Map()

    for (const entry of this.explained) {
      const key = `${entry.field} | ${entry.reason}`

      reasons.set(key, (reasons.get(key) || []).concat(entry))
    }

    for (const [key, entries] of reasons) {
      const sample = entries[0]

      console.log(`  explained x${entries.length} ${key} (first: ${sample.id} "${sample.name}", ${sample.stored} against ${sample.computed})`)
    }
  }
}

const query = (database, sql, parameters) => all(database, sql, parameters)

// Everything the rule needs of one race's harvesters, from one save.
const loadWorld = async (database, raceId, app) => {
  const [race] = await query(database, 'select RaceID, GameID, RaceName, NPR, SpecialNPRID, FuelProduction from FCT_Race where RaceID = :race', { ':race': raceId })

  if (!race) {
    throw new Error(`The save has no race ${raceId}`)
  }

  const parameters = { ':game': race.GameID, ':race': race.RaceID }
  const [game] = await query(database, 'select GameID, GameName, GameTime, LastGrowthTime, MinConstructionPeriod from FCT_Game where GameID = :game', { ':game': race.GameID })
  const gameColumns = (await query(database, "select name from pragma_table_info('FCT_Game')")).map((column) => column.name)
  const shape = SHAPE_COLUMNS.every((column) => gameColumns.includes(column)) ? '2.7' : 'other'
  const [tech] = await query(database, 'select max(FCT_TechSystem.AdditionalInfo) as Rate, count(*) as Techs from FCT_RaceTech inner join FCT_TechSystem on FCT_TechSystem.TechSystemID = FCT_RaceTech.TechID where FCT_RaceTech.GameID = :game and FCT_RaceTech.RaceID = :race and FCT_TechSystem.TechTypeID = ' + FUEL_RACIAL_RATE_TECH_TYPE, parameters)
  const components = await query(database, 'select FCT_ClassComponent.ClassID, FCT_ClassComponent.ComponentID, FCT_ClassComponent.NumComponent, FCT_ShipDesignComponents.ComponentTypeID, FCT_ShipDesignComponents.ComponentValue from FCT_ClassComponent inner join FCT_ShipDesignComponents on FCT_ShipDesignComponents.SDComponentID = FCT_ClassComponent.ComponentID where FCT_ClassComponent.GameID = :game and FCT_ClassComponent.ClassID in (select ShipClassID from FCT_ShipClass where GameID = :game and RaceID = :race) and FCT_ShipDesignComponents.ComponentTypeID in (' + HARVESTER_TYPE + ', ' + FUEL_STORAGE_TYPE + ')', parameters)
  const classes = new Map((await query(database, 'select ShipClassID, ClassName, Crew, Harvesters, FuelCapacity from FCT_ShipClass where GameID = :game and RaceID = :race', parameters)).map((row) => [row.ShipClassID, { ...row, harvesterRows: [], tankRows: [] }]))

  for (const component of components) {
    classes.get(component.ClassID)[component.ComponentTypeID === HARVESTER_TYPE ? 'harvesterRows' : 'tankRows'].push(component)
  }

  const ships = await query(database, 'select FCT_Ship.ShipID, FCT_Ship.ShipName, FCT_Ship.Fuel, FCT_Ship.CurrentCrew, FCT_Ship.ShipClassID, FCT_Ship.DistanceTravelled, FCT_Fleet.FleetID, FCT_Fleet.SystemID, FCT_Fleet.Xcor, FCT_Fleet.Ycor, FCT_Fleet.OrbitBodyID, FCT_Fleet.ParentCommandID from FCT_Ship inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID where FCT_Ship.GameID = :game and FCT_Ship.RaceID = :race and FCT_Ship.ShippingLineID = 0 order by FCT_Ship.ShipID', parameters)
  const harvesterShips = ships.filter((ship) => {
    const shipClass = classes.get(ship.ShipClassID)

    return shipClass && (shipClass.Harvesters > 0 || shipClass.harvesterRows.length > 0)
  })
  const damaged = new Map()

  for (const row of await query(database, 'select ShipID, ComponentID, Number from FCT_DamagedComponent where GameID = :game order by rowid', { ':game': race.GameID })) {
    damaged.set(row.ShipID, (damaged.get(row.ShipID) || []).concat(row))
  }

  const commanders = new Map((await query(database, 'select FCT_Commander.CommandID as ShipID, FCT_CommanderBonuses.BonusValue from FCT_Commander inner join FCT_CommanderBonuses on FCT_CommanderBonuses.CommanderID = FCT_Commander.CommanderID and FCT_CommanderBonuses.BonusID = ' + MINING_BONUS + ' where FCT_Commander.RaceID = :race and FCT_Commander.CommandType = ' + SHIP_COMMAND, { ':race': race.RaceID })).map((row) => [row.ShipID, row.BonusValue]))
  const bodies = await query(database, 'select SystemBodyID, SystemID, BodyTypeID, Xcor, Ycor, Name from FCT_SystemBody where GameID = :game and BodyTypeID in (' + GAS_BODY_TYPES.join(', ') + ') order by SystemBodyID', { ':game': race.GameID })
  const bodyTypes = new Map((await query(database, 'select SystemBodyID, BodyTypeID from FCT_SystemBody where GameID = :game and SystemBodyID in (select OrbitBodyID from FCT_Fleet where RaceID = :race)', parameters)).map((row) => [row.SystemBodyID, row.BodyTypeID]))
  const deposits = new Map((await query(database, 'select SystemBodyID, Amount, Accessibility, HalfOriginalAmount, OriginalAcc from FCT_MineralDeposit where GameID = :game and MaterialID = ' + SORIUM, { ':game': race.GameID })).map((row) => [row.SystemBodyID, row]))
  const surveyed = new Set((await query(database, 'select SystemBodyID from FCT_SystemBodySurveys where GameID = :game and RaceID = :race', parameters)).map((row) => row.SystemBodyID))
  const admins = await app.loadNavalAdmins({ query: (sql) => all(database, sql).then((rows) => [rows]) }, { GameID: race.GameID, RaceID: race.RaceID, bonusId: MINING_BONUS, share: 'Industrial' })
  const rootAdmin = Object.values(admins).find((admin) => !admin.ParentCommandID) || null

  return { race, game, shape, tech, classes, ships: harvesterShips, damaged, commanders, bodies, bodyTypes, deposits, surveyed, admins, rootAdmin, pageRows: new Map() }
}

// The page's rows for the race: the query of logistics.vue run on the save.
const loadPageRows = async (database, world) => new Map((await all(database, pageQuery(world.race.GameID, world.race.RaceID))).map((row) => [row.ShipID, row]))

// The undamaged count of one class component of a ship: the game takes the first damaged row of the component, and a ship without damage rows has every module.
const undamagedCount = (world, ship, row) => {
  const hit = (world.damaged.get(ship.ShipID) || []).find((damage) => damage.ComponentID === row.ComponentID)

  return row.NumComponent - (hit ? hit.Number : 0)
}

const bodyAt = (world, fleet) => world.bodies.filter((body) => Math.abs(body.Xcor - fleet.Xcor) < 1 && Math.abs(body.Ycor - fleet.Ycor) < 1)

// The rule's reading of one ship: its inputs from the save, the runtime state (what the game would do, whatever the race has surveyed) and the known state (what the race can know: output unknown on a body it has not surveyed).
const readShip = (world, ship, app) => {
  const shipClass = world.classes.get(ship.ShipClassID)
  const modules = shipClass.harvesterRows.reduce((sum, row) => sum + undamagedCount(world, ship, row), 0)
  const classModules = shipClass.harvesterRows.reduce((sum, row) => sum + row.NumComponent, 0)
  const capacity = shipClass.tankRows.reduce((sum, row) => sum + undamagedCount(world, ship, row) * row.ComponentValue, 0)
  const candidates = bodyAt(world, ship)
  const body = candidates[0] || null
  const deposit = body ? world.deposits.get(body.SystemBodyID) || null : null
  const known = body !== null && world.surveyed.has(body.SystemBodyID)
  const commander = world.commanders.has(ship.ShipID) ? world.commanders.get(ship.ShipID) : 1
  const command = ship.ParentCommandID || (world.rootAdmin ? world.rootAdmin.NavalAdminCommandID : 0)
  const admin = app.navalAdminChainBonus(world.admins, ship.SystemID, command)
  const input = { modules, rate: world.race.FuelProduction, commander, admin, crew: ship.CurrentCrew, classCrew: shipClass.Crew, accessibility: deposit ? deposit.Accessibility : null }
  const perYear = annualPotential(input)
  let status = 'works'

  if (world.race.SpecialNPRID === ANCIENTS) {
    status = 'ancients'
  } else if (!(modules > 0)) {
    status = 'no undamaged module'
  } else if (!(ship.Fuel < capacity)) {
    status = 'tanks full'
  } else if (!body) {
    status = 'no gas giant here'
  } else if (!deposit || !(deposit.Amount > 0)) {
    status = 'no Sorium'
  }

  return { id: ship.ShipID, name: ship.ShipName, ship, shipClass, modules, classModules, capacity, candidates, body, deposit, known, commander, admin, command, input, perYear, status, step: { modules, fuel: ship.Fuel, capacity, perYear, depositTons: deposit ? deposit.Amount : null } }
}

// The page's report as logistics.vue builds it: harvesterReport over every row of the page's query, for `years`. Its rows by ShipID.
const pageReport = (world, app, years) => new Map(app.harvesterReport([...world.pageRows.values()], { admins: world.admins, horizon: years, version: world.shape === '2.7' ? FORMULA_VERSION : null }).rows.map((row) => [row.ShipID, row]))

// What the page shows of one ship, in the rule's three states: it works, it does not, or the output is unknown (an unsurveyed body, or a missing module or tank count).
const pageState = (page) => (page.unknown ? 'unknown' : page.idle === null ? 'works' : 'idle')

// The same three states for the rule: a body the race has not surveyed hides the deposit, so a ship that would otherwise be working or lack Sorium is unknown there.
const ruleState = (state) => (state.body && !state.known && (state.status === 'works' || state.status === 'no Sorium') ? 'unknown' : state.status === 'works' ? 'works' : 'idle')

// The litres of one step the page can show: 0 where the ship cannot work for a reason the race can see, null (unknown) over a body it has not surveyed, otherwise the rule's step.
const ruleLitres = (state, years) => (['ancients', 'no undamaged module', 'tanks full', 'no gas giant here'].includes(state.status) ? 0 : !state.known ? null : harvestStep(state.step, years).litres)

const reconcileShips = (world, read, app, reports, years) => {
  const report = pageReport(world, app, years)

  for (const state of read) {
    const row = report.get(state.id)

    reports.page.checked++

    if (!row) {
      reports.page.mismatches.push({ id: state.id, name: state.name, field: 'row', stored: '-', computed: 'a harvester ship the page query leaves out' })
      continue
    }

    reports.page.same++

    const rowId = { id: state.id, name: state.name }
    const pageRoom = row.capacity === null ? null : Math.max(0, row.capacity - row.Fuel)
    const ruleRoom = Math.max(0, state.capacity - state.ship.Fuel)

    reports.rate.compare(rowId, 'racial rate', row.FuelProduction, state.input.rate, 'decimal')
    reports.modules.compare(rowId, 'modules', row.Harvesters, state.modules, 'exact')
    reports.commander.compare(rowId, 'Mining bonus', row.MiningBonus, state.commander, 'decimal')
    reports.admin.compare(rowId, 'admin bonus', app.harvesterAdminBonus(world.admins, row), state.admin, 'decimal')
    reports.crew.compare(rowId, 'crew fraction', app.crewFraction(row), crewFraction(state.input.crew, state.input.classCrew), 'decimal')
    reports.accessibility.compare(rowId, 'accessibility', row.SoriumAccessibility, state.known && state.deposit ? state.deposit.Accessibility : state.known ? 0 : null, 'exact')
    reports.capacity.compare(rowId, 'tank capacity', row.capacity, state.capacity, 'exact')
    reports.room.compare(rowId, 'tank room', pageRoom, ruleRoom, 'exact')
    reports.body.compare(rowId, 'body', row.SystemBodyID || 0, state.body ? state.body.SystemBodyID : 0, 'exact')
    reports.status.compare(rowId, 'harvesting state', pageState(row), ruleState(state), 'exact')

    // The rate is compared wherever the race can see the deposit, tanks full or not; the unconstrained figure is the rate the harvester works at.
    if (state.known && state.deposit && state.perYear !== null) {
      reports.output.compare(rowId, 'annual rate', row.perYear, state.perYear, 'decimal')
    }

    reports.obtainable.compare(rowId, `obtainable over ${years} yr`, row.obtainableLitres, ruleLitres(state, years), 'decimal')
  }
}

const printShips = (read, years) => {
  for (const state of read) {
    const step = harvestStep(state.step, years)

    console.log(`  ${state.id} "${state.name}" ${state.status}: modules ${state.modules}/${state.classModules}, fuel ${format(state.ship.Fuel)}/${format(state.capacity)}, potential ${state.perYear === null ? 'unknown' : format(state.perYear)} L/yr, ${years} yr ${step.litres === null ? 'unknown' : format(step.litres)} L (${step.limit})`)
  }
}

// Stored inputs against the rule.
const checkStoredInputs = (world, app) => {
  const rate = new Report('racial rate', [], 'FCT_Race.FuelProduction against the best researched Fuel Production tech, or the base rate with none')
  const classes = new Report('class totals', [], 'FCT_ShipClass.Harvesters and FuelCapacity against the class components')
  const deposits = new Report('deposit accessibility', [], 'FCT_MineralDeposit.Accessibility against the original accessibility, and below half the original amount against the game\'s decline')
  const tanks = new Report('tank level', [], 'FCT_Ship.Fuel against the undamaged tank capacity')
  const researched = world.tech.Techs > 0 ? world.tech.Rate : BASE_RACIAL_RATE

  rate.compare({ id: world.race.RaceID, name: world.race.RaceName }, 'FuelProduction', world.race.FuelProduction, researched, 'decimal')
  rate.notes.push(`${world.tech.Techs} Fuel Production techs researched; ${world.tech.Techs > 0 ? `best ${world.tech.Rate}` : `none, the base ${BASE_RACIAL_RATE}`}; the harvester component's own ComponentValue is not used by the game`)

  const used = new Set(world.ships.map((ship) => ship.ShipClassID))

  for (const shipClass of world.classes.values()) {
    if (!used.has(shipClass.ShipClassID)) {
      continue
    }

    const row = { id: shipClass.ShipClassID, name: shipClass.ClassName }

    classes.compare(row, 'Harvesters', shipClass.Harvesters, shipClass.harvesterRows.reduce((sum, component) => sum + component.NumComponent, 0), 'exact')
    classes.compare(row, 'FuelCapacity', shipClass.FuelCapacity, shipClass.tankRows.reduce((sum, component) => sum + component.NumComponent * component.ComponentValue, 0), 'exact')
  }

  for (const [body, deposit] of world.deposits) {
    const row = { id: body, name: 'Sorium deposit' }
    const below = deposit.Amount < deposit.HalfOriginalAmount

    deposits.compare(row, 'Accessibility', deposit.Accessibility, below ? declinedAccessibility(app.roundHalfEven, { amount: deposit.Amount, half: deposit.HalfOriginalAmount, original: deposit.OriginalAcc }) : deposit.OriginalAcc, 'decimal', () => (!below && deposit.Accessibility > deposit.OriginalAcc ? 'above its original accessibility on a deposit not yet mined below half: the game only lowers accessibility, so it was raised outside the game (the modded sample\'s)' : null))
  }

  deposits.notes.push(`${[...world.deposits.values()].filter((deposit) => deposit.Amount < deposit.HalfOriginalAmount).length} of ${world.deposits.size} Sorium deposits are below half their original amount`)

  for (const state of world.ships.map((ship) => readShip(world, ship, app))) {
    tanks.compare({ id: state.id, name: state.name }, 'Fuel', state.ship.Fuel <= state.capacity + ABSOLUTE_TOLERANCE ? 'within' : 'above', 'within', 'exact', () => (state.capacity < state.shipClass.FuelCapacity ? 'above the capacity of the undamaged tanks, as damaged tanks leave it' : null))
  }

  return [rate, classes, deposits, tanks]
}

// Worked cases on synthetic in-memory rows, labelled as such: each has its expected value written out by hand and must hold, or the check fails. Where the page's helper gives a different answer for the same case, `page` records it (a known gap, not a failure).
const workedCases = (app) => {
  const cases = []
  const add = (name, actual, expected, kind = 'exact') => cases.push({ name, actual, expected, kind })
  const base = { modules: 10, fuel: 0, capacity: 1000000, perYear: 400000, depositTons: 1000 }
  const step = (overrides, years = 1) => harvestStep({ ...base, ...overrides }, years)
  const potential = (overrides) => annualPotential({ modules: 10, rate: 40000, commander: 1, admin: 1, crew: 100, classCrew: 100, accessibility: 1, ...overrides })
  const row = (overrides) => ({ ClassCrew: 100, CurrentCrew: 100, Harvesters: 10, ClassHarvesters: 10, FuelProduction: 40000, MiningBonus: 1, SoriumAccessibility: 1, SoriumAmount: 1000, Surveyed: 1, SystemBodyID: 1, Fuel: 0, FuelCapacity: 1000000, ...overrides })
  // The page's helpers on the same case: its basis and the step over `years` (with a version the rule is stated for unless given).
  const page = (overrides, years = 1, version = FORMULA_VERSION) => {
    const basis = app.harvesterBasis(row(overrides), { version })

    return { basis, taken: app.harvesterObtainable(basis, years, version) }
  }
  const root = { 1: { NavalAdminCommandID: 1, SystemID: 5, ParentCommandID: 0, BonusValue: 1.2, Share: 0.05, Eligible: true, Systems: new Set([5]) } }

  add('full tanks: the step is exactly 0', step({ fuel: 1000000 }).litres, 0)
  add('full tanks: the limit named is the tanks', step({ fuel: 1000000 }).limit, 'tanks full')
  add('fuel above the capacity (damaged tanks): the step is 0', step({ fuel: 1200000 }).litres, 0)
  add('1 L of room, a huge rate: the step is exactly 1 L', step({ fuel: 999999, perYear: 4e9 }).litres, 1)
  add('99.95% full, a huge rate: the step is the 500 L of room, not 0', step({ fuel: 999500, perYear: 4e9 }).litres, 500)
  add('600,000 L of room under a 400,000 L step: the rate limits', step({ fuel: 400000 }).limit, 'rate')
  add('300,000 L of room under a 400,000 L step: the tank room limits', step({ fuel: 700000 }).litres, 300000)
  add('deposit exhaustion: 0.5 t left caps the step at 1,000 L', step({ depositTons: 0.5 }).litres, 1000)
  add('deposit exhaustion: the limit named is the deposit', step({ depositTons: 0.5 }).limit, 'deposit')
  add('an exhausted deposit (0 t): the step is 0', step({ depositTons: 0 }).litres, 0)
  add('a quarter year at 400,000 L a year: 100,000 L', step({}, 0.25).litres, 100000)
  add('one module: 40,000 L a year at accessibility 1', potential({ modules: 1 }), 40000)
  add('one module at accessibility 0.5 and a 1.5 commander: 30,000 L a year', potential({ modules: 1, accessibility: 0.5, commander: 1.5 }), 30000)
  add('damaged modules: 7 of 10 undamaged give 280,000 L a year', potential({ modules: 7 }), 280000)
  add('every module damaged: the step is 0 and the limit says so', step({ modules: 0 }).limit, 'no undamaged module')
  add('uncharted body: the potential is unknown (null), not 0', potential({ accessibility: null }), null)
  add('uncharted body: the step is unknown (null), not 0', step({ perYear: null, depositTons: null }).litres, null)
  add('crew at 50%: half the output', potential({ crew: 50 }), 200000)
  add('crew above the class crew: capped at the full output', potential({ crew: 150 }), 400000)
  add('class crew 0: the full output, no division by 0', potential({ classCrew: 0, crew: 0 }), 400000)
  add('naval admin 1.2 at a 5% share in range: 1.01', app.navalAdminChainBonus(root, 5, 1), 1.01, 'decimal')
  add('naval admin out of range: 1', app.navalAdminChainBonus(root, 6, 1), 1)
  add('Mining bonus and admin multiply: 10 modules, 1.5 and 1.01: 606,000 L a year', potential({ commander: 1.5, admin: 1.01 }), 606000, 'decimal')
  add('the accessibility decline: 0.7 original, a quarter of the half amount left: 0.25', declinedAccessibility(app.roundHalfEven, { amount: 25, half: 100, original: 0.7 }), 0.25, 'decimal')

  // The page's helpers on the cases that used to differ, each held to the rule's answer.
  add('page: full tanks: 0 litres, "Tanks full"', `${page({ Fuel: 1000000 }).taken.litres} ${page({ Fuel: 1000000 }).basis.idle}`, '0 Tanks full')
  add('page: 1 L of room, a huge rate: exactly 1 L', page({ Fuel: 999999, FuelProduction: 4e8 }).taken.litres, 1)
  add('page: 99.95% full, a huge rate: the 500 L of room, not "Tanks full"', page({ Fuel: 999500, FuelProduction: 4e8 }).taken.litres, 500)
  add('page: 600,000 L of room under a 400,000 L step: the rate limits', page({ Fuel: 400000 }).taken.limit, 'rate')
  add('page: 300,000 L of room under a 400,000 L step: the tanks limit, 300,000 L', `${page({ Fuel: 700000 }).taken.litres} ${page({ Fuel: 700000 }).taken.limit}`, '300000 tanks')
  add('page: 0.5 t left: 1,000 L, the deposit limits', `${page({ SoriumAmount: 0.5 }).taken.litres} ${page({ SoriumAmount: 0.5 }).taken.limit}`, '1000 deposit')
  add('page: an exhausted deposit (0 t): 0 litres, "No Sorium"', `${page({ SoriumAmount: 0 }).taken.litres} ${page({ SoriumAmount: 0 }).basis.idle}`, '0 No Sorium')
  add('page: a quarter year at 400,000 L a year: 100,000 L', page({}, 0.25).taken.litres, 100000)
  add('page: one module: 40,000 L a year', page({ Harvesters: 1 }).basis.perYear, 40000)
  add('page: damaged modules, 7 of 10 undamaged: 280,000 L a year', page({ Harvesters: 7 }).basis.perYear, 280000)
  add('page: every module damaged: 0 litres, "No working module"', `${page({ Harvesters: 0 }).taken.litres} ${page({ Harvesters: 0 }).basis.idle}`, '0 No working module')
  add('page: crew at 50%: 200,000 L a year', page({ CurrentCrew: 50 }).basis.perYear, 200000)
  add('page: crew above the class crew: 400,000 L a year', page({ CurrentCrew: 150 }).basis.perYear, 400000)
  add('page: class crew 0: 400,000 L a year', page({ ClassCrew: 0, CurrentCrew: 0 }).basis.perYear, 400000)
  add('page: uncharted body: the rate and the step are unknown (null), not 0', `${page({ Surveyed: 0, SoriumAmount: null, SoriumAccessibility: null }).basis.perYear} ${page({ Surveyed: 0, SoriumAmount: null, SoriumAccessibility: null }).taken.litres} ${page({ Surveyed: 0, SoriumAmount: null, SoriumAccessibility: null }).taken.result.status}`, 'null null unavailable')
  add('page: uncharted body with full tanks: exactly 0, which needs no deposit', page({ Surveyed: 0, SoriumAmount: null, SoriumAccessibility: null, Fuel: 1000000 }).taken.litres, 0)
  add('page: not at a gas giant: 0 litres, the rate unknown', `${page({ SystemBodyID: null, Surveyed: 0, SoriumAmount: null, SoriumAccessibility: null }).taken.litres} ${page({ SystemBodyID: null, Surveyed: 0, SoriumAmount: null, SoriumAccessibility: null }).basis.perYear}`, '0 null')
  add('page: unknown tank capacity (damaged-capacity data missing): the step is unknown, the rate and the fuel in the tanks stay', `${page({ FuelCapacity: null }).taken.litres} ${page({ FuelCapacity: null }).basis.perYear} ${page({ FuelCapacity: null }).basis.room}`, 'null 400000 null')
  add('page: unknown module count: the rate and the step are unknown', `${page({ Harvesters: null }).basis.perYear} ${page({ Harvesters: null }).taken.litres}`, 'null null')
  add('page: a result is confirmed for a save with the formula columns and estimated otherwise', `${page({}).basis.rate.status} ${page({}, 1, null).basis.rate.status} ${page({}).taken.result.status} ${page({}, 1, null).taken.result.status}`, 'confirmed estimated confirmed estimated')
  add('page: a fleet with no command takes the root command: 1.01', app.harvesterAdminBonus(root, { SystemID: 5, NavalAdminCommandID: 0 }), 1.01, 'decimal')
  add('page: a fleet out of the root command\'s range: 1', app.harvesterAdminBonus(root, { SystemID: 6, NavalAdminCommandID: 0 }), 1)

  // A deposit of 0.75 t (1,500 L) shared by two ships that would each fill 400,000 L: the body's total is the deposit, not twice it.
  const shared = app.harvesterReport([row({ ShipID: 1, SoriumAmount: 0.75 }), row({ ShipID: 2, SoriumAmount: 0.75 })], { admins: {}, horizon: 1, version: FORMULA_VERSION })

  add('page: two ships over a 1,500 L deposit: the body gives 1,500 L, not 3,000 L', shared.litres, 1500)
  add('page: two ships over a deposit that cannot cover them: each is flagged', shared.rows.every((entry) => entry.overDeposit), true)

  return cases
}

const printWorkedCases = (cases) => {
  let failed = 0

  console.log('worked cases (synthetic in-memory rows, not save rows):')

  for (const entry of cases) {
    const ok = entry.kind === 'decimal' ? close(entry.actual, entry.expected) : entry.actual === entry.expected

    failed += ok ? 0 : 1
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${entry.name}: ${format(entry.actual)}${ok ? '' : ` (expected ${entry.expected})`}`)
  }

  console.log(`  ${cases.length} cases, ${failed} failed`)

  return failed
}

// The construction cycles between two saves of one campaign: a cycle runs at the first increment more than MinConstructionPeriod after the last one, and sets LastGrowthTime. Replaying the newer save's ledger from the earlier save's LastGrowthTime must end at the newer save's. The save writes the ledger before its last increment, so the save's own GameTime is added as the final increment when it is past the ledger's tail (a pair whose last cycle ran at the save's GameTime needs it).
const replayCycles = async (older, newer, gameId) => {
  const [olderGame] = await query(older, 'select GameTime, LastGrowthTime, MinConstructionPeriod from FCT_Game where GameID = :game', { ':game': gameId })
  const [newerGame] = await query(newer, 'select GameTime, LastGrowthTime, MinConstructionPeriod from FCT_Game where GameID = :game', { ':game': gameId })
  const ledger = await query(newer, 'select GameTime from FCT_Increments where GameID = :game order by IncrementID', { ':game': gameId })

  if (!ledger.length || newerGame.GameTime > ledger[ledger.length - 1].GameTime) {
    ledger.push({ GameTime: newerGame.GameTime })
  }

  const [olderLedger] = await query(older, 'select count(*) as n, max(GameTime) as t from FCT_Increments where GameID = :game', { ':game': gameId })
  const prefix = ledger.length >= olderLedger.n && ledger[olderLedger.n - 1] && ledger[olderLedger.n - 1].GameTime === olderLedger.t
  let last = olderGame.LastGrowthTime
  const cycles = []

  for (const increment of ledger) {
    if (increment.GameTime > olderGame.LastGrowthTime && increment.GameTime - last > newerGame.MinConstructionPeriod) {
      cycles.push(increment.GameTime - last)
      last = increment.GameTime
    }
  }

  return { cycles, prefix, reproduced: last === newerGame.LastGrowthTime, olderGame, newerGame, lastReplayed: last }
}

// The observed reconciliation: each ship of the race in both saves, compared stationary-to-stationary, with the Sorium the deposits lost as a second, independent channel. A ship that travelled (burn), was refitted, changed its module count or sits over a deposit below half its original amount (the accessibility moves) is left out. The rule is run over the replayed cycles from the older tank level: a ship whose result is the capacity only shows the cap (the cycles' unconstrained output is a bound, not a value), one whose result differs from the stored fuel shows fuel moved by something the save does not record (a transfer: the rule cannot be wrong in the same direction for a ship that ends full), and only a ship below its capacity at both ends whose stored fuel equals the prediction is a clean observation.
const observe = async (database, olderDatabase, world, app, options) => {
  const gameId = world.race.GameID
  const older = await loadWorld(olderDatabase, options.race, app).catch((error) => ({ error }))

  if (older.error) {
    return { available: false, reason: `the earlier save has no readable race ${options.race}: ${older.error.message}`, lines: [] }
  }

  if (older.race.GameID !== gameId) {
    return { available: false, reason: `the earlier save's game ${older.race.GameID} is not the save's ${gameId}`, lines: [] }
  }

  const replay = await replayCycles(olderDatabase, database, gameId)
  const years = replay.cycles.reduce((sum, dt) => sum + dt, 0) / SECONDS_PER_YEAR
  const lines = [`earlier save: game time ${replay.olderGame.GameTime}, newer ${replay.newerGame.GameTime}; the earlier ledger is ${replay.prefix ? '' : 'NOT '}a prefix of the newer; ${replay.cycles.length} construction cycles replayed (${format(years)} yr), the replay ${replay.reproduced ? 'reproduces' : 'does NOT reproduce'} the newer LastGrowthTime ${replay.newerGame.LastGrowthTime} (replayed ${replay.lastReplayed})`]

  if (!replay.prefix || !replay.reproduced) {
    return { available: false, reason: 'the two saves are not one ledger or the cycles do not replay, so no cycle length is known', lines }
  }

  const before = new Map(older.ships.map((ship) => [ship.ShipID, readShip(older, ship, app)]))
  const counts = { shared: 0, moved: 0, refit: 0, different: 0, declining: 0, capped: 0, startedBelow: 0, boundHolds: 0, clean: 0, lost: 0, gained: 0 }
  const verdicts = []
  const bodies = new Map()

  for (const ship of world.ships) {
    const state = readShip(world, ship, app)
    const earlier = before.get(ship.ShipID)

    if (!earlier) {
      continue
    }

    counts.shared++

    if (earlier.ship.ShipClassID !== ship.ShipClassID) {
      counts.refit++
      continue
    }

    if (earlier.ship.DistanceTravelled !== ship.DistanceTravelled || earlier.ship.OrbitBodyID !== ship.OrbitBodyID) {
      counts.moved++
      continue
    }

    if (state.input.modules !== earlier.input.modules) {
      counts.different++
      continue
    }

    if (!state.deposit || !earlier.deposit || state.deposit.Amount < state.deposit.HalfOriginalAmount || earlier.deposit.Amount < earlier.deposit.HalfOriginalAmount || state.deposit.Accessibility !== earlier.deposit.Accessibility) {
      counts.declining++
      continue
    }

    let fuel = earlier.ship.Fuel

    for (const dt of replay.cycles) {
      fuel += harvestStep({ ...state.step, fuel, depositTons: Number.MAX_VALUE }, dt / SECONDS_PER_YEAR).litres
    }

    const observed = ship.Fuel
    const full = (value) => value >= state.capacity - ABSOLUTE_TOLERANCE
    const ceiling = state.perYear * years
    const body = bodies.get(state.body.SystemBodyID) || { id: state.body.SystemBodyID, taken: (earlier.deposit.Amount - state.deposit.Amount) * LITRES_PER_TON, net: 0, ceiling: 0, ships: 0 }

    body.net += observed - earlier.ship.Fuel
    body.ceiling += ceiling
    body.ships++
    bodies.set(body.id, body)

    if (full(fuel) && full(observed)) {
      counts.capped++
      counts.startedBelow += full(earlier.ship.Fuel) ? 0 : 1
      counts.boundHolds += observed - earlier.ship.Fuel <= ceiling + ABSOLUTE_TOLERANCE ? 1 : 0
      verdicts.push({ ship, kind: `refilled to the capacity ${format(state.capacity)} L from ${format(earlier.ship.Fuel)} L; the gain ${format(observed - earlier.ship.Fuel)} L is within the unconstrained ${format(ceiling)} L (the cap observed, the rate only bounded)` })
    } else if (close(fuel, observed)) {
      counts.clean++
      verdicts.push({ ship, kind: `reproduced: predicted ${format(fuel)} L, stored ${format(observed)} L from ${format(earlier.ship.Fuel)} L over ${replay.cycles.length} cycles` })
    } else if (observed < fuel) {
      counts.lost++
      verdicts.push({ ship, kind: `${format(fuel - observed)} L below the prediction ${format(fuel)} L (stored ${format(observed)} L, from ${format(earlier.ship.Fuel)} L): fuel left the ship by a transfer the save does not record` })
    } else {
      counts.gained++
      verdicts.push({ ship, kind: `${format(observed - fuel)} L above the prediction ${format(fuel)} L (stored ${format(observed)} L, from ${format(earlier.ship.Fuel)} L): the rule cannot give this; a transfer in, or a rate above the rule's` })
    }
  }

  lines.push(`ships in both saves ${counts.shared}: refitted ${counts.refit}, travelled (burn) ${counts.moved}, module count changed ${counts.different}, over a deposit below half its amount or whose accessibility changed ${counts.declining}; compared ${counts.capped + counts.clean + counts.lost + counts.gained}: ended at the capacity as predicted ${counts.capped} (${counts.startedBelow} started below it; the gain within the unconstrained bound on ${counts.boundHolds}), reproduced exactly below the capacity ${counts.clean}, below the prediction (fuel transferred away) ${counts.lost}, above it ${counts.gained}`)

  const others = new Map((await query(database, 'select FCT_Fleet.OrbitBodyID as SystemBodyID, count(*) as Ships from FCT_Ship inner join FCT_ShipClass on FCT_ShipClass.ShipClassID = FCT_Ship.ShipClassID and FCT_ShipClass.Harvesters > 0 inner join FCT_Fleet on FCT_Fleet.FleetID = FCT_Ship.FleetID where FCT_Ship.GameID = :game and FCT_Ship.RaceID <> :race group by FCT_Fleet.OrbitBodyID', { ':game': gameId, ':race': options.race })).map((row) => [row.SystemBodyID, row.Ships]))

  for (const body of bodies.values()) {
    const away = body.taken - body.net

    lines.push(`body ${body.id}: ${format(body.taken)} L of Sorium taken from the deposit, the ${body.ships} compared ships' tanks gained ${format(body.net)} L, so ${format(away)} L left the tanks by transfer or was taken by the ${others.get(body.id) || 0} other-race harvesters there; the unconstrained ceiling of those ships is ${format(body.ceiling)} L`)
  }

  for (const verdict of verdicts.filter((entry) => !entry.kind.startsWith('refilled')).concat(verdicts.filter((entry) => entry.kind.startsWith('refilled')).slice(0, 3))) {
    lines.push(`${verdict.ship.ShipID} "${verdict.ship.ShipName}": ${verdict.kind}`)
  }

  const reason = counts.clean > 0 ? null : counts.capped + counts.lost + counts.gained > 0 ? 'no compared ship ends below its capacity with a stored level the cycles reproduce: the tanks fill within the gap (the cap is observed, the rate only bounded) and the ships that do not end full lost fuel by transfers' : 'no stationary ship over a known deposit above half its amount is in both saves'

  return { available: counts.clean > 0, reason, lines, counts }
}

// The fuel service of the race's ships as the Logistics page reads it (utilities/fuel-donors.js loadFuelDonors, fed by the page's own database call shape), against SQL written here: the fuel aboard and the class minimum of every ship, the Transfer - Fuel systems each class mounts and each ship has left after damage, the tanker total against the sum the Fuel stock figure takes, every harvester ship among the rows, and the permission each ship gets against the gates read straight from the rows.
const checkFuelService = async (database, world, app) => {
  const report = new Report('fuel service on the page', ['fuelService.stored', 'fuelService.gameMinimum', 'fuelService.eligibleSurplus', 'fuelService.donor'])
  const { GameID, RaceID } = world.race
  const adapter = { query: async (sql) => [await all(database, sql)] }
  const rows = await app.fuelDonors.loadFuelDonors(adapter, { GameID, RaceID })
  const byShip = await fuelServiceTruth((sql) => all(database, sql), { GameID, RaceID })
  // A figure that may be unknown is compared exactly when either side is null: a tolerance would read nothing as 0.
  const kindOf = (stored, computed) => (stored === null || computed === null ? 'exact' : 'decimal')
  const tankers = [...byShip.values()].filter((row) => row.tanker === 1 && row.capacity > 0)
  const known = tankers.filter((row) => row.fuel !== null)
  // The sum of the fuel the save states: 0 with no counted tanker, unknown when counted tankers exist and none states any.
  const tankerSum = tankers.length === 0 ? 0 : known.length ? known.reduce((sum, row) => sum + row.fuel, 0) : null
  const donorReport = app.fuelDonors.tankerReport(rows, { version: world.shape === '2.7' ? FORMULA_VERSION : null })

  report.compare({ id: 'all', name: 'every tanker' }, 'the tanker total against the sum of the fuel aboard', donorReport.totals.stored.value, tankerSum, kindOf(donorReport.totals.stored.value, tankerSum))
  report.compare({ id: 'all', name: 'every tanker' }, 'the number of counted tankers', donorReport.totals.ships, tankers.length, 'exact')

  for (const ship of world.ships) {
    report.compare({ id: ship.ShipID, name: ship.ShipName }, 'the harvester has a row of the fuel service', rows.some((row) => row.ShipID === ship.ShipID && row.Harvester === 1), true, 'exact')
  }

  for (const row of rows) {
    const expected = byShip.get(row.ShipID)
    const id = { id: row.ShipID, name: row.ShipName }
    const donor = app.fuelDonors.fuelDonor(row)

    report.compare(id, 'the fuel aboard', row.Fuel, expected.fuel, kindOf(row.Fuel, expected.fuel))
    report.compare(id, 'the class minimum', row.MinimumFuel, expected.minimum, kindOf(row.MinimumFuel, expected.minimum))
    report.compare(id, 'the Transfer - Fuel systems of the class', row.TransferSystems, expected.systems, 'exact')
    report.compare(id, 'the Transfer - Fuel systems left', row.UndamagedTransfer, expected.left, 'exact')
    report.compare(id, 'the stored fuel of the result', donor.stored, expected.fuel, kindOf(donor.stored, expected.fuel))
    report.compare(id, 'the permission', donor.permission, expected.permission, 'exact')
    report.compare(id, 'the eligible surplus', donor.eligibleSurplus, expected.surplus, kindOf(donor.eligibleSurplus, expected.surplus))
  }

  return report
}

const main = async () => {
  const options = parseArguments(process.argv.slice(2))
  const database = await open(path.resolve(options.save)).catch((error) => fail(`Cannot open the save: ${error.message}`))
  const app = await loadApp()
  const world = await loadWorld(database, options.race, app).catch((error) => fail(error.message))
  world.pageRows = await loadPageRows(database, world).catch((error) => fail(`The page's harvesters query fails on this save: ${error.message}`))
  const read = world.ships.map((ship) => readShip(world, ship, app))

  console.log(`${path.basename(options.save)}: race ${world.race.RaceID} "${world.race.RaceName}"${world.race.NPR ? ' (NPR)' : ''}, game ${world.game.GameID} "${world.game.GameName}", ${world.shape === '2.7' ? 'a save with the formula columns (AllowCMC and AncientRelics present): the rule holds as the 2.7.x harvesting rule' : 'not a save with the formula columns: the 2.7.x rule is unverified for it, treat every figure as an estimate'}`)
  console.log(`${read.length} harvester ships, ${read.reduce((sum, state) => sum + state.modules, 0)} undamaged modules (class totals ${read.reduce((sum, state) => sum + state.classModules, 0)}); by state: ${Object.entries(read.reduce((counts, state) => ({ ...counts, [state.status]: (counts[state.status] || 0) + 1 }), {})).map(([status, count]) => `${count} ${status}`).join(', ') || 'none'}`)
  console.log(`factors away from neutral, over the ${read.length} ships: Mining bonus above 1 on ${read.filter((state) => state.commander !== 1).length}, admin bonus above 1 on ${read.filter((state) => state.admin !== 1).length}, crew below the class crew on ${read.filter((state) => state.input.crew < state.input.classCrew).length}, accessibility below 1 on ${read.filter((state) => state.input.accessibility !== null && state.input.accessibility < 1).length}, damaged harvester modules on ${read.filter((state) => state.modules !== state.classModules).length}, damaged tanks on ${read.filter((state) => state.capacity !== state.shipClass.FuelCapacity).length}, racial rate above the base ${BASE_RACIAL_RATE} on ${read.filter((state) => state.input.rate !== BASE_RACIAL_RATE).length}`)

  const stored = checkStoredInputs(world, app)
  const reports = {
    page: new Report('page rows', [], 'the page\'s harvesters query has a row for every harvester ship'),
    rate: new Report('rate on the page', APP_RULES),
    modules: new Report('modules on the page', APP_RULES),
    commander: new Report('Mining bonus on the page', APP_RULES),
    admin: new Report('admin bonus on the page', APP_RULES),
    crew: new Report('crew fraction on the page', APP_RULES),
    accessibility: new Report('accessibility on the page', APP_RULES),
    capacity: new Report('tank capacity on the page', APP_RULES),
    room: new Report('tank room on the page', APP_RULES),
    body: new Report('body on the page', APP_RULES),
    status: new Report('harvesting state on the page', APP_RULES),
    output: new Report('annual rate on the page', APP_RULES),
    obtainable: new Report(`fuel that fits over ${options.years} yr on the page`, APP_RULES),
  }

  reconcileShips(world, read, app, reports, options.years)
  reports.fuelService = await checkFuelService(database, world, app).catch((error) => fail(`The fuel service read fails on this save: ${error.message}`))

  console.log('\nstored inputs against the rule (rule verification against what the game wrote):')
  stored.forEach((report) => report.print(app.registry))
  console.log('\nthe page\'s figures against the rule (logistics.vue harvesters query, harvesterReport, harvesterBasis, harvesterObtainable, harvesterAdminBonus):')
  Object.values(reports).forEach((report) => report.print(app.registry))

  const potential = read.reduce((sum, state) => sum + (state.status === 'works' && state.perYear !== null ? state.perYear : 0), 0)
  const obtainable = read.reduce((sum, state) => sum + (state.status === 'works' ? harvestStep(state.step, options.years).litres || 0 : 0), 0)
  const unknown = read.filter((state) => !state.known && state.body).length

  console.log(`\nannual potential of the ships that harvest: ${format(potential)} L/yr; obtainable over ${options.years} yr from the current tanks and deposits: ${format(obtainable)} L (${read.filter((state) => state.status === 'works').length} ships; ${unknown} sit over a body the race has not surveyed, whose deposit it cannot see)`)

  if (options.list) {
    printShips(read, options.years)
  }

  console.log()

  const cases = workedCases(app)
  const failedCases = printWorkedCases(cases)
  let observed = null

  if (options.since) {
    const older = await open(path.resolve(options.since)).catch((error) => fail(`Cannot open the earlier save: ${error.message}`))

    observed = await observe(database, older, world, app, options)
    older.close()
    console.log(`\nobserved reconciliation against ${path.basename(options.since)} (kept apart from the rule verification above):`)
    observed.lines.forEach((line) => console.log(`  ${line}`))
    console.log(`  clean increment observation: ${observed.available ? 'available' : `unavailable - ${observed.reason}`}`)
  } else {
    console.log('\nobserved reconciliation: not run (no --since <earlier save of the same 2.7 campaign>)')
  }

  const registered = app.registry.listRules().filter((rule) => !APP_RULES.includes(rule.id) && rule.id.startsWith('logistics.harvester'))

  if (registered.length) {
    console.log(`registered harvester rules no check here covers: ${registered.map((rule) => `${rule.id} (${rule.verification})`).join(', ')}`)
  }

  const all = [...stored, ...Object.values(reports)]
  const mismatches = all.reduce((sum, report) => sum + report.mismatches.length, 0) + failedCases
  const explained = all.reduce((sum, report) => sum + report.explained.length, 0)

  database.close()
  console.log(`${mismatches} mismatches, ${explained} explained`)
  process.exit(mismatches ? 1 : 0)
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(2)
  })
}

module.exports = { checkFuelService }
