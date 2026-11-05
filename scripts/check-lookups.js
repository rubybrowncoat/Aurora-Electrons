/*
  Checks the ID-keyed lookup constants of the app against the Aurora 3.2.0 export (.github/exports/, the CSV export of the shipped 3.2.0 database, 213 files).

  node scripts/check-lookups.js [--no-mutations]

  A lookup table the app keys by ID must mean what the export says: the event icons (utilities/event-icons.js), the move actions the cargo actions read (utilities/transport.js, utilities/cargo-actions.js), the wealth uses of the civilian tariff (utilities/civilian-tariff.js), the commander bonuses and component types the planners gate (utilities/capabilities.js) name rows the export holds, under the names the export gives them, and no row the line removed. The rows the line added and removed are checked on the export as well, for the tables no constant keys: move actions 211-214 gone and 237 added, standing order 57, wealth uses 53-54-55, tech types 286-288, installations 53 and 54, event types 233 and 319 renamed and 373-382 added, the gases of 21 and 23-27 and the terrain's 76 rows. Each constant is read from its own module, so a constant that drifts from the export fails here rather than at a page.

  A row of the export is matched by its ID column (`ID_COLUMNS`; most tables list it first, `DIM_StandingOrders` lists the description first) and its name by the column the app keys it with (Description, Name, TypeDescription). The export is read as a CSV with quoted cells.
  Prints `N of N checks passed`; any failed check sets exit code 1. A planted fault is a copy of one module's source with one constant changed, and the check that names it must fail there; with --no-mutations no fault is planted.
*/
const fs = require('fs')
const path = require('path')
const { assert } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')

const repo = path.resolve(__dirname, '..')
const EXPORTS = path.join(repo, '.github', 'exports')

// One CSV cell per column, a quoted cell kept whole (the export writes `"a,b"` for a value that holds a comma).
const cellsOf = (line) => {
  const cells = []
  let cell = ''
  let quoted = false

  for (let index = 0; index < line.length; index++) {
    const character = line[index]

    if (character === '"') {
      quoted = !quoted
    } else if (character === ',' && !quoted) {
      cells.push(cell)
      cell = ''
    } else {
      cell += character
    }
  }

  cells.push(cell)

  return cells
}

// The ID column of each lookup the app keys by ID: the first column of most tables, not of DIM_StandingOrders, which lists the description first.
const ID_COLUMNS = { DIM_CommanderBonusType: 'BonusID', DIM_ComponentType: 'ComponentTypeID', DIM_EventType: 'EventTypeID', DIM_Gases: 'GasID', DIM_MoveAction: 'MoveActionID', DIM_PlanetaryInstallation: 'PlanetaryInstallationID', DIM_PlanetaryTerrain: 'TerrainID', DIM_StandingOrders: 'OrderID', DIM_TechType: 'TechTypeID', DIM_WealthUse: 'WealthUseID' }

// A table of the export as [{ [column]: text }], with the header's column names and its rows by ID.
const table = (name) => {
  const file = path.join(EXPORTS, `${name}.csv`)

  assert.ok(fs.existsSync(file), `${name}.csv is not in .github/exports/`)

  const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/)
  const header = cellsOf(lines[0])
  const idColumn = ID_COLUMNS[name]
  const rows = lines.slice(1).map((line) => {
    const cells = cellsOf(line)

    return Object.fromEntries(header.map((column, index) => [column, cells[index] === undefined ? '' : cells[index]]))
  })

  return { name, header, rows, idColumn, byId: new Map(rows.map((row) => [Number(row[idColumn]), row])) }
}

const EXPORT = Object.fromEntries(['DIM_CommanderBonusType', 'DIM_ComponentType', 'DIM_EventType', 'DIM_Gases', 'DIM_MoveAction', 'DIM_PlanetaryInstallation', 'DIM_PlanetaryTerrain', 'DIM_StandingOrders', 'DIM_TechType', 'DIM_WealthUse'].map((name) => [name, table(name)]))

// The name a row carries, by the table: the app keys each table by its own name column.
const NAMES = { DIM_CommanderBonusType: 'Description', DIM_ComponentType: 'TypeDescription', DIM_EventType: 'Description', DIM_MoveAction: 'Description', DIM_PlanetaryInstallation: 'Name', DIM_StandingOrders: 'Description', DIM_TechType: 'Description', DIM_WealthUse: 'Description' }
const nameOf = (name, id) => {
  const row = EXPORT[name].byId.get(id)

  return row ? String(row[NAMES[name]]).trim() : null
}

const checks = []
const check = (name, run) => checks.push({ name, run })

// ---- The constants the app keys by ID --------------------------------------------------------------------------------

check('every event type an icon is drawn for is a type of the export', ({ icons }) => {
  const missing = Object.keys(icons.EVENT_ICONS).map(Number).filter((id) => !EXPORT.DIM_EventType.byId.has(id))

  assert.deepEqual(missing, [], `types ${missing.join(', ')} are not in the export`)
})

check('the nine event types the line added are drawn', ({ icons }) => {
  const added = [373, 374, 375, 376, 377, 378, 379, 380, 381]

  added.forEach((id) => assert.ok(id in icons.EVENT_ICONS, `type ${id} has no icon`))
})

check('the event type Aurora 3.2 added is drawn, and is the export\'s Game Saved', ({ icons }) => {
  assert.ok(382 in icons.EVENT_ICONS, 'type 382 has no icon')
  assert.equal(nameOf('DIM_EventType', 382), 'Game Saved')
})

check('the name each icon carries is the description of the export', ({ iconNames }) => {
  Object.entries(iconNames).forEach(([id, name]) => {
    const description = nameOf('DIM_EventType', Number(id))

    if (description) {
      assert.equal(name, description, `type ${id}`)
    }
  })
})

check('the event rows the line changed are the export\'s rows', () => {
  assert.equal(nameOf('DIM_EventType', 233), 'New Hostile Alien Ship')
  assert.equal(nameOf('DIM_EventType', 319), 'Light Naval Construction')
  assert.deepEqual([373, 374, 375, 376, 377, 378, 379, 380, 381].map((id) => nameOf('DIM_EventType', id)), ['Xenoarchaeology Research', 'Artifacts Recovered', 'Aether Gate Detected', 'All Minerals Exhausted', 'New Neutral Alien Ship', 'New Friendly Alien Ship', 'New Allied Alien Ship', 'Mining Colony Update', 'Incomplete Salvage'])
  assert.equal(EXPORT.DIM_EventType.rows.length, 250)
  ;[122, 143].forEach((id) => assert.equal(EXPORT.DIM_EventType.byId.get(id).PlayerInterrupt, '1', `type ${id}`))
})

check('every load the cargo actions classify is an export row that loads, and every unload unloads', ({ transport }) => {
  Object.entries(transport.LOADS).forEach(([id, kind]) => {
    assert.match(nameOf('DIM_MoveAction', Number(id)) || '', /^Load/, `move action ${id} (${kind})`)
  })
  Object.entries(transport.UNLOADS).forEach(([id, kind]) => {
    assert.match(nameOf('DIM_MoveAction', Number(id)) || '', /^(?:Unload|Load\/Unload)/, `move action ${id} (${kind})`)
  })
})

check('the item loads and unloads are the loads and unloads the cargo actions classify', ({ transport, cargo }) => {
  cargo.ITEM_LOADS.forEach((id) => assert.ok(String(id) in transport.LOADS, `item load ${id} is not in LOADS`))
  cargo.ITEM_UNLOADS.forEach((id) => assert.ok(String(id) in transport.UNLOADS, `item unload ${id} is not in UNLOADS`))
})

check('the move actions the line removed are gone and Load All Ship Components is in', ({ transport, cargo }) => {
  ;[211, 212, 213, 214].forEach((id) => {
    assert.ok(!EXPORT.DIM_MoveAction.byId.has(id), `move action ${id} is still in the export`)
    assert.ok(!(String(id) in transport.LOADS) && !(String(id) in transport.UNLOADS), `the app still classifies move action ${id}`)
    assert.ok(!cargo.ITEM_LOADS.has(id) && !cargo.ITEM_UNLOADS.has(id), `the app still classifies item move action ${id}`)
  })
  assert.equal(nameOf('DIM_MoveAction', 237), 'Load All Ship Components')
  assert.equal(EXPORT.DIM_MoveAction.rows.length, 117)
})

check('standing order 57 is LD: Civilian Contract', () => {
  assert.equal(nameOf('DIM_StandingOrders', 57), 'LD: Civilian Contract')
  assert.equal(EXPORT.DIM_StandingOrders.rows.length, 48)
})

check('every civilian wealth use the tariff names is an export row under its name', ({ tariff }) => {
  tariff.CIVILIAN_USES.forEach((use) => assert.equal(nameOf('DIM_WealthUse', use.id), use.label, `wealth use ${use.id}`))
})

check('the wealth uses the line added are the export\'s three project uses', () => {
  assert.deepEqual([53, 54, 55].map((id) => nameOf('DIM_WealthUse', id)), ['Engineering Projects', 'Ordnance Projects', 'Ground Unit Projects'])
  assert.equal(EXPORT.DIM_WealthUse.rows.length, 54)
})

check('every commander bonus the planners gate is an export row under its name, on the side of the ledger the app reads', ({ capabilities }) => {
  Object.entries(capabilities.BONUS_NAMES).forEach(([id, bonus]) => {
    const row = EXPORT.DIM_CommanderBonusType.byId.get(Number(id))

    assert.ok(row, `bonus ${id} is not in the export`)
    assert.equal(String(row.Description).trim(), bonus.name, `bonus ${id}`)
    assert.equal(Number(row.Percentage) === 1, bonus.percentage, `bonus ${id} is read as ${bonus.percentage ? 'a multiplier' : 'a rating'}`)
  })
})

check('the commander bonus the line removed is gone and Light Tactical is in', () => {
  assert.ok(!EXPORT.DIM_CommanderBonusType.byId.has(26), 'bonus 26 is still in the export')
  assert.equal(nameOf('DIM_CommanderBonusType', 39), 'Light Tactical')
  assert.equal(EXPORT.DIM_CommanderBonusType.rows.length, 34)
})

check('every component type the planners gate is an export row under its name', ({ capabilities }) => {
  Object.entries(capabilities.COMPONENT_TYPES).forEach(([id, type]) => assert.equal(nameOf('DIM_ComponentType', Number(id)), type.name, `component type ${id}`))
})

check('the component type the line removed is gone and Ordnance Factory Module is in', () => {
  assert.ok(!EXPORT.DIM_ComponentType.byId.has(65), 'component type 65 is still in the export')
  assert.equal(nameOf('DIM_ComponentType', 72), 'Ordnance Factory Module')
  assert.equal(EXPORT.DIM_ComponentType.rows.length, 58)
})

check('the tech types the line added are the export\'s rows', () => {
  assert.deepEqual([286, 287, 288].map((id) => nameOf('DIM_TechType', id)), ['Ordnance Factory Module', 'Aether Gate Detection', 'Aether Gate Prevention'])
  assert.equal(EXPORT.DIM_TechType.rows.length, 218)
})

check('the installations the line added are the export\'s rows', () => {
  assert.deepEqual([53, 54].map((id) => nameOf('DIM_PlanetaryInstallation', id)), ['Light Naval Shipyard', 'Aether Gate Monitoring Station'])
  assert.equal(EXPORT.DIM_PlanetaryInstallation.rows.length, 39)
})

check('the gases the line added are the export\'s rows, twenty-eight in all', () => {
  ;[21, 23, 24, 25, 26, 27].forEach((id) => assert.ok(EXPORT.DIM_Gases.byId.has(id), `gas ${id} is not in the export`))
  assert.equal(EXPORT.DIM_Gases.rows.length, 28)
})

check('the terrain export holds the line\'s seventy-six rows', () => {
  assert.equal(EXPORT.DIM_PlanetaryTerrain.rows.length, 76)
})

// ---- The planted faults ----------------------------------------------------------------------------------------------

// The names the icon comments carry, read from the module's source: the icon is drawn from the key, and the comment is the name the export gives the type.
const iconNamesOf = () => {
  const source = fs.readFileSync(path.join(repo, 'src', 'renderer', 'utilities', 'event-icons.js'), 'utf8')
  const names = {}

  source.replace(/^\s+(\d+): '[^']+', \/\/ (.*)$/gm, (_match, id, name) => {
    names[id] = name.trim().replace(/\s+\(unused\)$/, '')

    return ''
  })

  return names
}

// The module sources the constants are read from, by the key the loader stubs them under.
const MODULES = { 'event-icons': 'utilities/event-icons.js', transport: 'utilities/transport.js', 'cargo-actions': 'utilities/cargo-actions.js', 'civilian-tariff': 'utilities/civilian-tariff.js', capabilities: 'utilities/capabilities.js' }

const sources = () => Object.fromEntries(Object.entries(MODULES).map(([key, file]) => [key, fs.readFileSync(path.join(repo, 'src', 'renderer', file), 'utf8')]))

// The utilities as the app ships them, or with one module's source replaced: `{ [key]: source }` stands for a planted fault.
const load = async (replacements = {}) => {
  const modules = await loadUtilities(['event-icons', 'transport', 'cargo-actions', 'civilian-tariff', 'capabilities'], { sources: { ...sources(), ...replacements } })

  return { icons: modules['event-icons'], transport: modules.transport, cargo: modules['cargo-actions'], tariff: modules['civilian-tariff'], capabilities: modules.capabilities, iconNames: iconNamesOf() }
}

const FAULTS = [
  { name: 'an event icon is drawn for a type the export lacks', key: 'event-icons', from: "  367: 'mdi-account-search', // Interrogation Update", to: "  367: 'mdi-account-search', // Interrogation Update\n  400: 'mdi-account-search', // No Such Type", fails: ['every event type an icon is drawn for is a type of the export'] },
  { name: 'a move action the line removed is classified again', key: 'transport', from: "export const LOADS = { 4: 'colonists'", to: "export const LOADS = { 211: 'colonists', 4: 'colonists'", fails: ['the move actions the line removed are gone and Load All Ship Components is in'] },
  { name: 'a commander bonus is read under another name', key: 'capabilities', from: "2: Object.freeze({ name: 'Survey'", to: "2: Object.freeze({ name: 'Surveying'", fails: ['every commander bonus the planners gate is an export row under its name, on the side of the ledger the app reads'] },
  { name: 'the icon of the event type Aurora 3.2 added is dropped', key: 'event-icons', from: "  382: 'mdi-content-save', // Game Saved\n", to: '', fails: ['the event type Aurora 3.2 added is drawn, and is the export\'s Game Saved'] },
]

const failedChecks = async (context) => {
  const failed = []

  for (const entry of checks) {
    try {
      await entry.run(context)
    } catch (error) {
      failed.push({ name: entry.name, message: String(error.message || error) })
    }
  }

  return failed
}

const run = async () => {
  let passed = 0
  const total = checks.length + (mutating() ? FAULTS.length : 0)
  const real = await load()
  const realFailures = await failedChecks(real)

  passed += checks.length - realFailures.length
  realFailures.forEach(({ name, message }) => console.log(`FAIL ${name}\n     ${message.split('\n').join('\n     ')}`))

  for (const fault of mutating() ? FAULTS : []) {
    try {
      const replacement = plantedPatch(MODULES[fault.key], sources()[fault.key], fault.from, fault.to)
      const planted = await load({ [fault.key]: replacement })
      const failures = (await failedChecks(planted)).map(({ name }) => name)
      const missed = fault.fails.filter((name) => !failures.includes(name))

      if (missed.length) {
        throw new Error(`the check does not fail: ${missed.join(', ')}`)
      }

      passed++
    } catch (error) {
      console.log(`FAIL mutant: ${fault.name}\n     ${String(error.message).split('\n').join('\n     ')}`)
    }
  }

  console.log(`${passed} of ${total} checks passed`)
  process.exitCode = passed === total ? 0 : 1
}

run().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
