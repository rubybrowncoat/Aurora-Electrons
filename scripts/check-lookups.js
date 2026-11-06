/*
  Checks the ID-keyed lookup constants of the app against the Aurora 3.2.0 export (.github/exports/, the CSV export of the shipped 3.2.0 database, 213 files).

  bun scripts/check-lookups.js [--no-mutations] (bun: the terrain IDs of the bodies of the default save are read with bun:sqlite)

  A lookup table the app keys by ID must mean what the export says: the event icons (utilities/event-icons.js), the move actions the cargo actions read (utilities/transport.js, utilities/cargo-actions.js), the wealth uses of the civilian tariff (utilities/civilian-tariff.js), the commander bonuses and component types the planners gate (utilities/capabilities.js) name rows the export holds, under the names the export gives them, and no row the line removed. The rows the line added and removed are checked on the export as well, for the tables no constant keys: move actions 211-214 gone and 237 added, standing order 57, wealth uses 53-54-55, tech types 286-288, installations 53 and 54, event types 233 and 319 renamed and 373-382 added, the gases of 21 and 23-27 and the terrain's 76 rows. Each constant is read from its own module, so a constant that drifts from the export fails here rather than at a page.

  A row of the export is matched by its ID column (`ID_COLUMNS`; most tables list it first, `DIM_StandingOrders` lists the description first) and its name by the column the app keys it with (Description, Name, TypeDescription). The export is read as a CSV with quoted cells.

  The terrain palette of the system view (components/SystemView.vue) is one of those constants, keyed by the terrain ID of a body: every terrain ID the export holds must draw a body, an ID the export does not hold must draw the view's stated fallback and not be passed off as a terrain the palette knows, and the palette may key no other ID. Every terrain ID a body of the default save carries is held to the same, since a body is drawn by the terrain the game gave it. The thirty-five terrain rows the line added are held to the export with the atmosphere each requires, and the six gas rows with their names.

  Prints `N of N checks passed`; any failed check sets exit code 1. A planted fault is a copy of one module's source with one constant changed, and the check that names it must fail there; with --no-mutations no fault is planted.
*/
const fs = require('fs')
const path = require('path')
const { assert } = require('./lib/fault-credit')
const { loadUtilities } = require('./lib/utilities')
const { loadModule } = require('./lib/page-loader')
const { plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { FIXTURE, fixturePath, fixtureRows } = require('./lib/fixtures')

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
const NAMES = { DIM_CommanderBonusType: 'Description', DIM_ComponentType: 'TypeDescription', DIM_EventType: 'Description', DIM_Gases: 'Name', DIM_MoveAction: 'Description', DIM_PlanetaryInstallation: 'Name', DIM_StandingOrders: 'Description', DIM_TechType: 'Description', DIM_WealthUse: 'Description' }
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

// The thirty-five terrain rows the line added, with the atmosphere each requires: `AtmosphereRequired` is the selector's 0-3, where 0 is excluded at a pressure of 0.005 atm or more and 1 below it, while 2 and 3 pass either.
const ADDED_TERRAIN = [[42, 1], [43, 1], [44, 1], [45, 2], [46, 2], [47, 2], [48, 2], [49, 1], [50, 1], [51, 1], [52, 1], [53, 1], [54, 2], [55, 2], [56, 1], [57, 1], [58, 1], [59, 1], [60, 1], [61, 2], [62, 2], [63, 2], [64, 2], [65, 2], [66, 2], [67, 2], [68, 0], [69, 0], [70, 0], [71, 0], [72, 1], [73, 0], [74, 2], [75, 1], [76, 1]]

check('the gases the line added are the export\'s rows under their names, twenty-eight in all', () => {
  assert.deepEqual([21, 23, 24, 25, 26, 27].map((id) => nameOf('DIM_Gases', id)), ['Ethane', 'Acetylene', 'Hydrogen Cyanide', 'Kyrpton', 'Xenon', 'Hydrazine'])
  assert.equal(EXPORT.DIM_Gases.rows.length, 28)
})

check('the gas export holds the per-breather danger columns the line added and neither of the two it removed', () => {
  const added = ['DangerousOxygen', 'DangerousPPMOxygen', 'DangerousMethane', 'DangerousPPMMethane', 'DangerousSulphur', 'DangerousPPMSulphur', 'DangerousAmmonia', 'DangerousPPMAmmonia', 'FreezingPoint', 'LiquidWaterPossible', 'BreathableGas', 'IceHydrospherePossible', 'Notes']
  assert.deepEqual(added.filter((column) => !EXPORT.DIM_Gases.header.includes(column)), [])
  assert.deepEqual(['Dangerous', 'DangerousLevel'].filter((column) => EXPORT.DIM_Gases.header.includes(column)), [])
  assert.equal(EXPORT.DIM_Gases.header.length, 20)
})

check('the terrain export holds the line\'s seventy-six rows, and the thirty-five it added with the atmosphere each requires', () => {
  const ids = [...EXPORT.DIM_PlanetaryTerrain.byId.keys()].sort((left, right) => left - right)

  assert.equal(EXPORT.DIM_PlanetaryTerrain.rows.length, 76)
  assert.deepEqual(ids.slice(0, 41), Array.from({ length: 41 }, (_value, index) => index + 1))
  assert.deepEqual(ADDED_TERRAIN.map(([id]) => [id, Number(EXPORT.DIM_PlanetaryTerrain.byId.get(id)?.AtmosphereRequired)]), ADDED_TERRAIN)
})

// ---- The terrain palette of the system view ---------------------------------------------------------------------------

// A planet as the system view draws it, with one terrain: free of water so that the terrain decides the colour, and at the temperature of a temperate world.
const DRAWN_BODY = Object.freeze({ BodyTypeID: 2, HydroID: 1, HydroExt: 0, AtmosPress: 0.5, SurfaceTemp: 15, Albedo: 0.9, Ring: 0, SystemBodyID: 1 })
const isColour = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffff
const drawnFill = (view, body) => view.pickBodyColor({ ...DRAWN_BODY, ...body }).fill
const drawnTerrain = (view, terrain) => drawnFill(view, { DominantTerrain: terrain })

check('the system view draws a body for every terrain ID of the export', ({ view }) => {
  const blank = [...EXPORT.DIM_PlanetaryTerrain.byId.keys()].filter((id) => {
    try {
      return !isColour(drawnTerrain(view, id))
    } catch {
      return true
    }
  })

  assert.deepEqual(blank, [], `terrain ${blank.join(', ')} draws no body`)
})

check('the system view draws every terrain its palette keys in a colour of its own, not the fallback of one it does not know', ({ view, palette }) => {
  const fallback = drawnTerrain(view, 0)
  const rocky = drawnFill(view, { DominantTerrain: 0, SurfaceTemp: undefined, BaseTemp: undefined })
  const fallen = palette.map((entry) => entry.id).filter((id) => [fallback, rocky].includes(drawnTerrain(view, id)))

  assert.deepEqual(fallen, [], `terrain ${fallen.join(', ')} draws the fallback of a terrain the palette does not know`)
})

check('the colours the terrain palette states are colours the view can draw', ({ palette }) => {
  const wrong = palette.filter((entry) => !/^0x[0-9a-f]{6}$/i.test(entry.colour) || Number(entry.colour) > 0xffffff).map((entry) => `${entry.id}: ${entry.colour}`)

  assert.deepEqual(wrong, [], `the palette states ${wrong.join(', ')}`)
})

check('a terrain the export lacks takes the stated fallback of the system view and is passed off as no terrain the palette knows', ({ view, palette }) => {
  const unlisted = [0, 77, 200].map((terrain) => drawnTerrain(view, terrain))
  const known = new Set(palette.map((entry) => drawnTerrain(view, entry.id)))
  const withoutTemperature = drawnFill(view, { DominantTerrain: 0, SurfaceTemp: undefined, BaseTemp: undefined })
  const problems = []

  if (!unlisted.every(isColour)) problems.push(`an ID the export lacks draws ${unlisted.join(', ')}, not a colour`)
  if (new Set(unlisted).size !== 1) problems.push(`the IDs the export lacks do not draw alike (${unlisted.join(', ')})`)
  if (known.has(unlisted[0])) problems.push(`an ID the export lacks draws ${unlisted[0]}, the colour of a terrain the palette knows`)
  if (!isColour(withoutTemperature)) problems.push(`a body whose temperature the save does not give draws ${withoutTemperature}, not a colour`)
  if (withoutTemperature === unlisted[0]) problems.push(`a body whose temperature the save does not give draws the temperate fallback ${unlisted[0]}, so the temperature is not read`)

  assert.deepEqual(problems, [])
})

check('the terrain palette of the system view keys only terrain IDs of the export', ({ palette }) => {
  assert.deepEqual(palette.map((entry) => entry.id).filter((id) => !EXPORT.DIM_PlanetaryTerrain.byId.has(id)), [])
})

check('the system view draws a body for every terrain ID a body of the default save carries', ({ view }) => {
  const file = fixturePath()

  assert.ok(fs.existsSync(file), `the default save ${FIXTURE.file} is not there, so the terrain IDs of its bodies are not held`)

  const blank = fixtureRows('select distinct DominantTerrain as terrain from FCT_SystemBody where DominantTerrain is not null order by DominantTerrain').map((row) => row.terrain).filter((terrain) => !isColour(drawnTerrain(view, terrain)))

  assert.deepEqual(blank, [], `terrain ${blank.join(', ')} draws no body`)
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

// The module sources the constants are read from, by the key the loader stubs them under. The system view is a page (a .vue file), loaded as a module with `pickBodyColor` exported.
const MODULES = { 'event-icons': 'utilities/event-icons.js', transport: 'utilities/transport.js', 'cargo-actions': 'utilities/cargo-actions.js', 'civilian-tariff': 'utilities/civilian-tariff.js', capabilities: 'utilities/capabilities.js', view: 'components/SystemView.vue' }

const sources = () => Object.fromEntries(Object.entries(MODULES).map(([key, file]) => [key, fs.readFileSync(path.join(repo, 'src', 'renderer', file), 'utf8')]))

// The system view as a module: its script with `pickBodyColor` exported, so that the checks draw with the function the view draws with. The view names its modules by the app's `~` alias, which the page loader resolves only from a relative path, so the alias is rewritten to the path from the view's own folder; the packages the view only draws with stand in as stubs.
const VIEW = 'components/SystemView'
const VIEW_STUBS = {
  'pixi.js': 'export const settings = { ROUND_PIXELS: false }',
  'pixi-viewport': 'export class Viewport {}',
  '@timohausmann/quadtree-js': 'export default class Quadtree {}',
  lodash: 'export const clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value))',
}
const VIEW_MODULES = { 'components/charts/theme': 'export const mapFont = () => ({ family: \'Test\', size: (px) => px })' }

const viewSource = (text) => {
  const script = require('vue/compiler-sfc').parse({ source: text }).script.content
  const exported = `${script}\n\nexport { pickBodyColor }\n`
  const aliased = exported.replace(/from '~\/([\w\-/.]+)'/g, (_match, specifier) => `from '${specifier.startsWith('components/') ? `./${specifier.slice('components/'.length)}` : `../${specifier}`}'`)

  return text.replace(script, aliased)
}

// The terrain palette of the view as [{ id, colour }], read from its table. Every entry is kept, whatever its colour, so that a colour the view cannot use fails a check rather than leaving its terrain looking unkeyed; a check that cannot find the table fails rather than reading an empty palette as no keyed terrain.
const terrainPalette = (text) => {
  const block = /const TERRAIN = \{([\s\S]*?)\n {2}\}/.exec(text)

  assert.ok(block, 'the system view has no terrain palette')
  const entries = [...block[1].matchAll(/^\s+(\d+): (0x[0-9a-fA-F]+),$/gm)].map(([, id, colour]) => ({ id: Number(id), colour }))

  assert.ok(entries.length > 0, 'the terrain palette of the system view lists no colour')

  return entries
}

// The utilities and the view as the app ships them, or with one module's source replaced: `{ [key]: source }` stands for a planted fault.
const load = async (replacements = {}) => {
  const text = { ...sources(), ...replacements }
  const modules = await loadUtilities(['event-icons', 'transport', 'cargo-actions', 'civilian-tariff', 'capabilities'], { sources: text })
  const view = await loadModule(VIEW, { sources: { [VIEW]: viewSource(text.view) }, stubs: VIEW_STUBS, modules: VIEW_MODULES })

  return { icons: modules['event-icons'], transport: modules.transport, cargo: modules['cargo-actions'], tariff: modules['civilian-tariff'], capabilities: modules.capabilities, view, palette: terrainPalette(text.view), iconNames: iconNamesOf() }
}

const FAULTS = [
  { name: 'an event icon is drawn for a type the export lacks', key: 'event-icons', from: "  367: 'mdi-account-search', // Interrogation Update", to: "  367: 'mdi-account-search', // Interrogation Update\n  400: 'mdi-account-search', // No Such Type", fails: ['every event type an icon is drawn for is a type of the export'] },
  { name: 'a move action the line removed is classified again', key: 'transport', from: "export const LOADS = { 4: 'colonists'", to: "export const LOADS = { 211: 'colonists', 4: 'colonists'", fails: ['the move actions the line removed are gone and Load All Ship Components is in'] },
  { name: 'a commander bonus is read under another name', key: 'capabilities', from: "2: Object.freeze({ name: 'Survey'", to: "2: Object.freeze({ name: 'Surveying'", fails: ['every commander bonus the planners gate is an export row under its name, on the side of the ledger the app reads'] },
  { name: 'the icon of the event type Aurora 3.2 added is dropped', key: 'event-icons', from: "  382: 'mdi-content-save', // Game Saved\n", to: '', fails: ['the event type Aurora 3.2 added is drawn, and is the export\'s Game Saved'] },
  { name: 'a terrain colour of the system view is outside the range a colour has', key: 'view', from: '    22: 0xd5d0c4,', to: '    22: 0x1d5d0c4,', fails: ['the system view draws every terrain its palette keys in a colour of its own, not the fallback of one it does not know'] },
  { name: 'the system view keys a terrain the export lacks', key: 'view', from: '    7: 0x3f5d2e,', to: '    7: 0x3f5d2e,\n    99: 0x3f5d2e,', fails: ['the terrain palette of the system view keys only terrain IDs of the export'] },
  { name: 'a terrain the export lacks is drawn in a colour of its own instead of the stated fallback', key: 'view', from: '    return null\n  }\n\n  const waterStateColor', to: '    return 0x556070\n  }\n\n  const waterStateColor', fails: ['a terrain the export lacks takes the stated fallback of the system view and is passed off as no terrain the palette knows'] },
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
