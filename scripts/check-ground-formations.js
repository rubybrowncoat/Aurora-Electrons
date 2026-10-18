/*
  Checks the selected race's ground formation hierarchy (src/renderer/utilities/ground-formations.js) against figures worked out by hand and against the saves.

  Run: node scripts/check-ground-formations.js [--no-mutations] [--no-breadth]

  The groups, each check a PASS or FAIL line:
  - A constructed race of 24 formations, fed as deep-frozen rows to the pure builder: orphan and foreign parents, loops, templates, locations, unknown figures, totals and the tree, with the figures worked out by hand; then five formations more for the roles (geo, xeno, both, unknown), whether a formation is remote and in which system it is shown, and the grouping by system with the totals per role.
  - The SELECT statements, and the loader on an in-memory SQLite database that holds rows of another race, another game and another race's survey names (never a save).
  - The named saves, opened read-only: every figure of the model is compared with SQL written separately here, and a reader with one table hidden must make that comparison fail.
  - Every other AuroraDB*.db that can be found (the repository, its saves folder, and the artifacts folders), one check per game and race. A save without the tables is reported UNSUPPORTED and a save without formation rows EMPTY: neither counts as agreement.
  - Mutations of the utility in a temporary copy, each of which must make a named check fail.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const MODULE = 'ground-formations'

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

// The packages the utilities import: the commanders module, which the post holders take the serving test from, reads dates with dayjs.
const STUBS = {
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
}
const FILE = `${MODULE}.js`

let checks = 0
let failures = 0
let unsupportedSaves = 0
let emptySaves = 0
let skippedSaves = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

const parseArguments = (argv) => {
  const options = { mutations: true, breadth: true, part: null }

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]

    if (argument === '--no-mutations') {
      options.mutations = false
    } else if (argument === '--no-breadth') {
      options.breadth = false
    } else if (argument === '--part') {
      options.part = argv[++index]
    } else {
      console.error(`Unknown argument: ${argument}`)
      process.exit(2)
    }
  }

  return options
}

const settle = async (fn) => {
  try {
    return { value: await fn() }
  } catch (error) {
    return { error }
  }
}

const frozen = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen)
    Object.freeze(value)
  }

  return value
}

const near = (a, b) => a === b || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const sorted = (list) => [...list].sort((a, b) => a - b)

// Every formation once, found by walking the top-level entries and their children (bounded, so a loop cannot hang the check).
const walk = (model) => {
  const seen = []
  const queue = [...model.roots]
  const limit = model.byId.size * 2 + 2

  while (queue.length && seen.length <= limit) {
    const id = queue.shift()

    seen.push(id)
    queue.push(...model.byId.get(id).children)
  }

  return seen
}

const partitioned = (model) => {
  const seen = walk(model)

  return same(sorted(seen), sorted(Array.from(model.byId.keys()))) && model.formations.length === model.byId.size
}

// Each known figure is the sum of what its listed elements contribute, every listed element belongs to the formation, and a figure that is unknown names why.
const traced = (model) => model.formations.every((node) => ['mass', 'geo', 'xeno'].every((kind) => {
  const figure = node[kind]
  const listed = new Set(node.elements.map((item) => item.id))

  if (!figure.from.every((entry) => listed.has(entry.elementId))) {
    return false
  }

  if (figure.value === null) {
    return figure.unknown.length > 0
  }

  return figure.unknown.length === 0 && near(figure.from.reduce((sum, entry) => sum + entry.contribution, 0), figure.value) && (kind !== 'mass' || figure.from.length === node.elements.length)
}))

let rowSequence = 0

const formation = (FormationID, over = {}) => ({ FormationID, Name: `Formation ${FormationID}`, Abbreviation: `F${FormationID}`, RaceID: 7, GameID: 1, OriginalTemplateID: 0, ReplacementTemplateID: 0, PopulationID: 1, ShipID: 0, ParentFormationID: 0, ...over })
const element = (FormationID, ClassID, Units) => ({ RowID: ++rowSequence, ElementID: rowSequence * 10, FormationID, ClassID, SpeciesID: 1, Units })
const infantry = (FormationID, units = 1) => element(FormationID, 10, units)
const groundClass = (GroundUnitClassID, ClassName, Size, ComponentA = 0) => ({ GroundUnitClassID, ClassName, Size, ComponentA, ComponentB: 0, ComponentC: 0, ComponentD: 0 })

const RACE = 7
const GAME = 1

// A constructed race: formation 1 is the root of 1-2-3-24 (3 embarked), 4-5 hang from a parent that is not in the save, 6 from a formation of another race, 7-8-9 and 10 hold loops, 11 has no elements, 12 a class that is not stored, 13-14 odd templates, 15-20 locations, 21-23 figures the save cannot give.
const syntheticRows = () => {
  rowSequence = 0

  return {
    formations: [
      formation(1),
      formation(2, { ParentFormationID: 1 }),
      formation(3, { ParentFormationID: 2, ShipID: 100, PopulationID: 0 }),
      formation(4, { ParentFormationID: 99 }),
      formation(5, { ParentFormationID: 4 }),
      formation(6, { ParentFormationID: 300 }),
      formation(7, { ParentFormationID: 8 }),
      formation(8, { ParentFormationID: 7 }),
      formation(9, { ParentFormationID: 7 }),
      formation(10, { ParentFormationID: 10 }),
      formation(11),
      formation(12),
      formation(13, { OriginalTemplateID: 777, ReplacementTemplateID: 21 }),
      formation(14, { OriginalTemplateID: 22 }),
      formation(15, { ShipID: 404, PopulationID: 0 }),
      formation(16, { ShipID: 101, PopulationID: 0 }),
      formation(17, { ShipID: 102, PopulationID: 0 }),
      formation(18, { PopulationID: 404 }),
      formation(19, { PopulationID: 0 }),
      formation(20, { ShipID: 100 }),
      formation(21),
      formation(22),
      formation(23),
      formation(24, { ParentFormationID: 3 }),
      formation(99999, { RaceID: 8 }),
      formation(99998, { GameID: 2 }),
      formation(1, { Name: 'Duplicate of 1' }),
    ],
    outsideParents: [{ FormationID: 300, RaceID: 8, GameID: 1 }],
    elements: [
      element(1, 13, 1),
      infantry(1, 10),
      element(2, 11, 5),
      element(3, 12, 2),
      infantry(4),
      infantry(5, 2),
      infantry(6),
      infantry(7),
      infantry(8),
      infantry(9),
      infantry(10),
      element(12, 99, 4),
      infantry(12),
      infantry(13),
      infantry(14),
      infantry(15),
      infantry(16),
      infantry(17),
      infantry(18),
      infantry(19),
      infantry(20),
      element(21, 15, 2),
      infantry(21),
      element(22, 16, 3),
      infantry(23, null),
      infantry(24),
      element(99999, 10, 7),
    ],
    classes: [
      groundClass(10, 'Infantry', 5),
      groundClass(11, 'Geo Survey', 100, 26),
      groundClass(12, 'Xeno Survey', 100, 64),
      { ...groundClass(13, 'Headquarters', 120, -1), ComponentB: -1, ComponentC: -1, ComponentD: -1 },
      groundClass(15, 'Odd', 7, 999),
      groundClass(16, 'Unsized', null, 26),
    ],
    components: [
      { ComponentTypeID: 26, ComponentName: 'Geo', Geosurvey: 0.1, Xenoarchaeology: 0 },
      { ComponentTypeID: 64, ComponentName: 'Xeno', Geosurvey: 0, Xenoarchaeology: 0.5 },
    ],
    templates: [
      { TemplateID: 21, RaceID: 7, Name: 'Battalion', Abbreviation: 'BN', Obsolete: 0 },
      { TemplateID: 22, RaceID: 8, Name: 'Foreign', Abbreviation: 'FN', Obsolete: 1 },
    ],
    templateElements: [
      { FormationTemplateID: 21, ClassID: 10, Units: 10 },
      { FormationTemplateID: 21, ClassID: 11, Units: 2 },
    ],
    ships: [
      { ShipID: 100, ShipName: 'Hauler', FleetID: 500, MothershipID: 0 },
      { ShipID: 101, ShipName: 'Lost', FleetID: 600, MothershipID: 0 },
      { ShipID: 102, ShipName: 'Lander', FleetID: 0, MothershipID: 100 },
    ],
    fleets: [{ FleetID: 500, FleetName: 'Convoy', RaceID: 7, SystemID: 9, OrbitBodyID: 77, SystemName: 'Alpha' }],
    populations: [{ PopulationID: 1, PopName: 'Alpha Prime', RaceID: 7, SystemID: 50, SystemBodyID: 5, SystemName: 'Sol' }],
  }
}

const EXPECTED_PROBLEMS = {
  'orphan-parent': 1,
  'foreign-parent': 1,
  'parent-cycle': 3,
  'no-elements': 1,
  'class-missing': 1,
  'units-unknown': 1,
  'component-missing': 1,
  'size-unknown': 1,
  'template-missing': 1,
  'template-foreign': 1,
  'ship-missing': 1,
  'fleet-missing': 1,
  'population-missing': 1,
  unlocated: 1,
  'both-locations': 1,
}

const countKinds = (problems) => problems.reduce((counts, problem) => ({ ...counts, [problem.kind]: (counts[problem.kind] || 0) + 1 }), {})

const reversedRows = (rows) => Object.fromEntries(Object.entries(rows).map(([key, list]) => [key, [...list].reverse()]))

// The constructed race with five formations more, for where a formation is and what role it has: 25 holds both ratings and 26 geo with the xeno rating unstored, both aboard the ship at system 9; 27 is at a colony in a system the race has no name for, 28 aboard a ship in one, and 29 at a colony of another race in a system it names.
const extendedRows = () => {
  const rows = syntheticRows()

  return {
    ...rows,
    formations: [...rows.formations, formation(25, { ShipID: 100, PopulationID: 0 }), formation(26, { ShipID: 100, PopulationID: 0 }), formation(27, { PopulationID: 2 }), formation(28, { ShipID: 105, PopulationID: 0 }), formation(29, { PopulationID: 3 })],
    elements: [...rows.elements, element(25, 11, 1), element(25, 12, 1), element(26, 17, 2), infantry(27), infantry(28), infantry(29)],
    classes: [...rows.classes, groundClass(17, 'Half rated', 3, 27)],
    components: [...rows.components, { ComponentTypeID: 27, ComponentName: 'Half', Geosurvey: 0.2, Xenoarchaeology: null }],
    ships: [...rows.ships, { ShipID: 105, ShipName: 'Far', FleetID: 501, MothershipID: 0 }],
    fleets: [...rows.fleets, { FleetID: 501, FleetName: 'Dark', RaceID: 7, SystemID: 71, OrbitBodyID: 0, SystemName: null }],
    populations: [...rows.populations, { PopulationID: 2, PopName: 'Outpost', RaceID: 7, SystemID: 70, SystemBodyID: 6, SystemName: null }, { PopulationID: 3, PopName: 'Captured', RaceID: 8, SystemID: 80, SystemBodyID: 7, SystemName: 'Beta' }],
  }
}

// The results of the builder checks on a module: [{ id, name, ok }]. A check that throws fails.
const builderResults = async (mod) => {
  const results = []
  const add = async (id, name, fn) => {
    const outcome = await settle(fn)

    results.push({ id, name, ok: outcome.value === true, detail: outcome.error ? outcome.error.message : typeof outcome.value === 'string' ? outcome.value : '' })
  }
  const built = await settle(() => mod.buildGroundFormations(frozen(syntheticRows()), { GameID: GAME, RaceID: RACE }))
  const m = built.value
  const node = (id) => m.byId.get(id)
  const problemKinds = (id) => node(id).problems.map((problem) => problem.kind)

  await add('frozen', 'the builder reads deep-frozen rows without writing to them', () => m !== undefined)
  await add('filter', 'rows of another race or game are left out and counted, and never enter a total', () => m.summary.formations === 24 && m.summary.excluded === 2 && m.summary.strayElements === 1 && m.formations.length === 24 && !m.byId.has(99999) && !m.byId.has(99998))
  await add('duplicates', 'a repeated formation row is counted once and the first row is kept', () => m.summary.duplicateRows === 1 && node(1).name === 'Formation 1' && node(1).elements.length === 2)
  await add('parents', 'a parent link is none, resolved, orphan, foreign or the cut of a loop as the rows say', () => [1, 2, 4, 6, 7, 8, 10].map((id) => node(id).parent.state).join(',') === 'none,resolved,orphan,foreign,cycle,resolved,cycle' && node(6).parent.raceId === 8 && node(4).parent.id === 99)
  await add('orphan', 'an orphan parent is unresolved, visible at the top and anchors the formations below it', () => same(node(4).anchor, { kind: 'orphan', id: 4 }) && same(node(5).anchor, { kind: 'orphan', id: 4 }) && node(4).resolved === false && node(5).resolved === false && node(5).depth === 1 && problemKinds(4).includes('orphan-parent') && !problemKinds(5).includes('orphan-parent') && m.summary.orphans === 1 && m.roots.includes(4))
  await add('foreign-parent', 'a parent of another race is shown as foreign and not as an orphan', () => same(node(6).anchor, { kind: 'foreign', id: 6 }) && problemKinds(6).includes('foreign-parent') && !problemKinds(6).includes('orphan-parent') && m.summary.foreignParents === 1 && m.summary.orphans === 1)
  await add('cycle', 'a loop ends at its lowest id, is listed with its members, and every member says so', () => same(m.cycles, [{ id: 'cycle:7', members: [7, 8], cutAt: 7 }, { id: 'cycle:10', members: [10], cutAt: 10 }]) && same(node(7).anchor, { kind: 'cycle', id: 7 }) && node(9).anchor.id === 7 && node(8).problems.some((problem) => problem.kind === 'parent-cycle' && problem.cycleId === 'cycle:7') && !problemKinds(9).includes('parent-cycle') && m.summary.cycles === 2 && m.summary.cycleMembers === 3 && m.roots.includes(7) && m.roots.includes(10))
  await add('roots', 'the top-level entries are the formations with no parent, then the orphans, then the rest by id', () => same(m.roots, [1, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 4, 6, 7, 10]) && m.summary.roots === 14 && m.summary.topLevel === 18)
  await add('partition', 'walking the top-level entries and their children reaches every formation exactly once', () => partitioned(m))
  await add('unresolved', 'a formation is unresolved when its top is not a formation with no parent', () => same(m.formations.filter((item) => !item.resolved).map((item) => item.id), [4, 5, 6, 7, 8, 9, 10]) && m.summary.unresolved === 7)
  await add('depth', 'depth counts the parent links up to the top-level entry', () => node(24).depth === 3 && node(1).depth === 0 && node(3).depth === 2 && node(9).depth === 1 && same(node(24).anchor, { kind: 'root', id: 1 }) && node(24).resolved === true)
  await add('mass', 'mass is the sum of class size times units of the elements, unknown where an input is missing', () => [1, 2, 3, 4, 5, 21].map((id) => node(id).mass.value).join(',') === '170,500,200,5,10,19' && [11, 12, 22, 23].every((id) => node(id).mass.value === null) && m.summary.mass.value === 974 && m.summary.mass.unknownFormations === 4)
  await add('units', 'units and element rows add up to the rows given, an unknown count named', () => m.summary.units.value === 46 && m.summary.units.unknownElements === 1 && m.summary.elements === 26 && m.formations.reduce((sum, item) => sum + item.elements.length, 0) === 26)
  await add('unknown', 'a formation with no elements, a missing class, an unsized class or unknown units is unknown and never 0', () => node(11).mass.value === null && node(11).geo.value === null && node(11).xeno.value === null && node(11).mass.unknown[0].reason.includes('no element rows') && node(12).mass.value === null && node(12).geo.value === null && node(21).mass.value === 19 && node(21).geo.value === null && node(21).xeno.value === null && node(21).geo.unknown[0].reason.includes('catalogue') && node(22).mass.value === null && node(23).mass.value === null && node(23).geo.value === null && node(23).xeno.value === null)
  await add('geo-xeno', 'geosurvey and xenoarchaeology come from the equipment of the elements, empty slots count nothing', () => near(node(2).geo.value, 0.5) && node(2).xeno.value === 0 && near(node(3).xeno.value, 1) && node(3).geo.value === 0 && node(1).geo.value === 0 && near(node(22).geo.value, 0.3) && node(22).xeno.value === 0 && near(m.summary.geo.value, 0.8) && m.summary.geo.unknownFormations === 4 && near(m.summary.xeno.value, 1) && m.summary.xeno.unknownFormations === 4)
  await add('trace', 'every figure lists the elements behind it and is their sum', () => traced(m) && node(2).geo.from.length === 1 && node(2).geo.from[0].perUnit === 0.1 && node(2).geo.from[0].units === 5 && node(1).geo.from.length === 0 && node(1).mass.from.length === 2)
  await add('tree', 'the tree of a formation adds the formations below it and counts the unknown ones', () => node(1).tree.formations === 4 && node(1).tree.mass.value === 875 && near(node(1).tree.geo.value, 0.5) && near(node(1).tree.xeno.value, 1) && node(4).tree.formations === 2 && node(4).tree.mass.value === 15 && node(7).tree.formations === 3 && node(7).tree.mass.value === 15 && node(10).tree.formations === 1 && m.roots.reduce((sum, id) => sum + node(id).tree.formations, 0) === 24 && m.roots.reduce((sum, id) => sum + node(id).tree.mass.value, 0) === 974 && m.roots.reduce((sum, id) => sum + node(id).tree.mass.unknownFormations, 0) === 4 && m.roots.reduce((sum, id) => sum + node(id).tree.geo.unknownFormations, 0) === 4)
  await add('templates', 'a template is none, found with its composition, missing or foreign, and the states add up', () => {
    const t = m.summary.templates

    return same(t.missing, { original: 1, replacement: 0 }) && same(t.foreign, { original: 1, replacement: 0 }) && same(t.found, { original: 0, replacement: 1 }) && same(t.none, { original: 22, replacement: 23 }) && node(13).templates.original.state === 'missing' && node(13).templates.original.id === 777 && node(13).templates.replacement.state === 'found' && node(13).templates.replacement.name === 'Battalion' && same(node(13).templates.replacement.elements, [{ classId: 10, className: 'Infantry', units: 10 }, { classId: 11, className: 'Geo Survey', units: 2 }]) && node(14).templates.original.state === 'foreign' && node(14).templates.original.raceId === 8 && node(14).templates.original.obsolete === true && node(14).templates.replacement.state === 'none' && problemKinds(13).includes('template-missing') && problemKinds(14).includes('template-foreign') && !problemKinds(1).includes('template-missing')
  })
  await add('location-colony', 'a formation at a colony has the colony and its system, and the colony wins over a ship', () => same(node(1).location, { kind: 'colony', state: 'resolved', population: { id: 1, name: 'Alpha Prime', systemId: 50, systemName: 'Sol', bodyId: 5, raceId: 7 }, ship: null, fleet: null, system: { id: 50, name: 'Sol' } }) && node(20).location.kind === 'colony' && problemKinds(20).includes('both-locations'))
  await add('location-ship', 'an embarked formation takes the system of the carrying fleet', () => same(node(3).location.fleet, { id: 500, name: 'Convoy', systemId: 9, systemName: 'Alpha', bodyId: 77, raceId: 7, via: 'ship' }) && node(3).location.kind === 'ship' && node(3).location.state === 'resolved' && node(3).location.ship.name === 'Hauler' && same(node(3).location.system, { id: 9, name: 'Alpha' }))
  await add('location-fallback', 'a ship carried by another follows the fleet of the ship that carries it', () => node(17).location.fleet.via === 'mothership' && node(17).location.fleet.id === 500 && node(17).location.ship.carriedBy.id === 100 && node(17).location.ship.mothershipId === 100 && node(17).location.system.id === 9)
  await add('location-unresolved', 'a ship, fleet or colony that is not found, and no location at all, are unresolved with a problem each', () => [15, 16, 18, 19].every((id) => node(id).location.state === 'unresolved' && node(id).location.system === null) && problemKinds(15).includes('ship-missing') && problemKinds(16).includes('fleet-missing') && problemKinds(18).includes('population-missing') && problemKinds(19).includes('unlocated') && same(m.summary.locations, { colony: 18, ship: 2, unresolved: 4 }))
  await add('problems', 'every problem is listed once with its formation and the counts are those worked out', () => (same(Object.entries(countKinds(m.problems)).sort(), Object.entries(EXPECTED_PROBLEMS).sort()) && m.problems.every((problem) => m.byId.has(problem.formationId) && typeof problem.message === 'string')) || JSON.stringify(countKinds(m.problems)))
  await add('deterministic', 'the order of the rows does not change the model', () => {
    const again = mod.buildGroundFormations(reversedRows(syntheticRows()), { GameID: GAME, RaceID: RACE })

    return same([again.summary, again.roots, again.cycles], [m.summary, m.roots, m.cycles])
  })
  await add('location-follows-fleet', 'moving the fleet moves the embarked formations and no colony formation', () => {
    const rows = syntheticRows()

    rows.fleets = [{ ...rows.fleets[0], SystemID: 12, SystemName: 'Beta', OrbitBodyID: 88 }]

    const moved = mod.buildGroundFormations(rows, { GameID: GAME, RaceID: RACE })

    return same(moved.byId.get(3).location.system, { id: 12, name: 'Beta' }) && moved.byId.get(3).location.fleet.bodyId === 88 && same(moved.byId.get(17).location.system, { id: 12, name: 'Beta' }) && same(moved.byId.get(1).location.system, { id: 50, name: 'Sol' })
  })
  await add('unknown-parent', 'a parent link that is not stored is unknown and unresolved', () => {
    const rows = { formations: [formation(1, { ParentFormationID: null }), formation(2, { ParentFormationID: 1 })], elements: [infantry(1), infantry(2)] }
    const unknown = mod.buildGroundFormations(rows, { GameID: GAME, RaceID: RACE })

    return unknown.summary.unknownParents === 1 && unknown.byId.get(1).parent.state === 'unknown' && unknown.byId.get(2).anchor.kind === 'unknown' && unknown.byId.get(2).resolved === false && unknown.summary.unresolved === 2 && partitioned(unknown)
  })

  const extended = mod.buildGroundFormations(frozen(extendedRows()), { GameID: GAME, RaceID: RACE })
  const xNode = (id) => extended.byId.get(id)
  const placeOf = (id) => mod.formationPlace(xNode(id), extended)
  const placeText = (id) => `${placeOf(id).remote}|${placeOf(id).system ? placeOf(id).system.id : 'none'}|${placeOf(id).reasons.map((reason) => reason.kind).join(',')}`
  const remoteGroups = mod.groupBySystem(extended, (_node, place) => place.remote === true)
  const allGroups = mod.groupBySystem(extended)
  const adds = (totals) => totals.geo + totals.xeno - totals.both + totals.other + totals.unknown === totals.formations

  await add('roles', 'a formation is geo or xeno above a rating of 0, other at 0 for both, in both roles with both ratings, and in none while a rating is unknown', () => same(mod.formationRoles(xNode(2)).list, ['geo']) && same(mod.formationRoles(xNode(3)).list, ['xeno']) && same(mod.formationRoles(xNode(1)).list, ['other']) && same(mod.formationRoles(xNode(25)).list, ['geo', 'xeno']) && mod.formationRoles(xNode(25)).other === false && same(mod.formationRoles(xNode(26)).list, ['geo']) && same(mod.formationRoles(xNode(26)).unknownRoles, ['xeno']) && mod.formationRoles(xNode(26)).other === false && mod.formationRoles(xNode(11)).undetermined === true && same(mod.formationRoles(xNode(21)).unknownRoles, ['geo', 'xeno', 'other']) && mod.formationRoles(xNode(21)).list.length === 0 && same(mod.GROUND_ROLES, ['geo', 'xeno', 'other']))
  await add('role-totals', 'the role totals add up to the formations, a formation with both ratings once, and an unknown rating is its own count', () => same(mod.roleTotals(extended), { formations: 29, geo: 4, xeno: 2, other: 20, both: 1, unknown: 4 }) && adds(mod.roleTotals(extended)) && same(mod.roleTotals(m), { formations: 24, geo: 2, xeno: 1, other: 17, both: 0, unknown: 4 }) && adds(mod.roleTotals(m)) && same(mod.roleTotals(extended, (_node, place) => place.remote === true), { formations: 9, geo: 2, xeno: 2, other: 6, both: 1, unknown: 0 }) && adds(mod.roleTotals(extended, (_node, place) => place.remote === true)))
  await add('place', 'a formation is remote when it is aboard a ship, stored with no place or at a colony of another race, not remote at a colony of the race (a ship in its system changes nothing), and not known where its colony is missing', () => [1, 20, 27].every((id) => placeOf(id).remote === false) && [3, 15, 16, 17, 19, 25, 26, 28, 29].every((id) => placeOf(id).remote === true) && placeOf(18).remote === null && placeOf(3).kind === 'ship' && placeOf(1).kind === 'colony' && placeOf(19).kind === 'unlocated')
  await add('place-system', 'a system is given only where the race stores its survey name, never taken from a colony or fleet whose system has none', () => ['1|50', '20|50', '3|9', '17|9', '25|9', '26|9', '29|80'].every((text) => { const [id, system] = text.split('|'); return placeText(Number(id)).split('|')[1] === system }) && [15, 16, 18, 19, 27, 28].every((id) => placeOf(id).system === null))
  await add('place-unresolved', 'a formation with no known system says why, with the reason the model gave, and a system with no stored survey name is named as that', () => same([15, 16, 18, 19, 27, 28].map(placeText), ['true|none|ship-missing', 'true|none|fleet-missing', 'null|none|population-missing', 'true|none|unlocated', 'false|none|system-not-surveyed', 'true|none|system-not-surveyed']) && placeOf(15).reasons[0].message.includes('404'))
  await add('group-system', 'the remote formations group by system, a formation with both ratings once and in each of its roles, and those with no known system are left unplaced with their reasons', () => same(Object.keys(remoteGroups.systems).sort(), ['80', '9']) && same(remoteGroups.systems['9'].formations, [3, 17, 25, 26]) && same(remoteGroups.systems['9'].roles, { geo: 2, xeno: 2, other: 1, unknown: 0 }) && same(remoteGroups.systems['9'].sets, { xeno: 1, other: 1, 'geo+xeno': 1, geo: 1 }) && remoteGroups.systems['9'].name === 'Alpha' && same(remoteGroups.systems['80'].formations, [29]) && same(remoteGroups.unplaced, [{ id: 15, reasons: ['ship-missing'] }, { id: 16, reasons: ['fleet-missing'] }, { id: 19, reasons: ['unlocated'] }, { id: 28, reasons: ['system-not-surveyed'] }]) && remoteGroups.formations === 9)
  await add('group-reconcile', 'every kept formation is in exactly one system or unplaced, whatever is kept, and no system carries more than an id, a name, formations, roles and sets', () => allGroups.formations === 29 && Object.values(allGroups.systems).reduce((sum, entry) => sum + entry.formations.length, 0) + allGroups.unplaced.length === 29 && same(sorted([...Object.values(allGroups.systems).flatMap((entry) => entry.formations), ...allGroups.unplaced.map((entry) => entry.id)]), sorted(extended.formations.map((item) => item.id))) && same(allGroups.unplaced.map((entry) => entry.id), [15, 16, 18, 19, 27, 28]) && Object.values(allGroups.systems).every((entry) => same(Object.keys(entry).sort(), ['formations', 'id', 'name', 'roles', 'sets'])) && mod.groupBySystem(extended, () => false).formations === 0)

  return results
}

const allRows = (raw, sql) => new Promise((resolve, reject) => {
  raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows)))
})

const runStatement = (raw, sql, params = []) => new Promise((resolve, reject) => {
  raw.run(sql, params, (error) => (error ? reject(error) : resolve()))
})

const standIn = (raw) => ({
  query: async (sql) => [await allRows(raw, sql)],
  close: () => new Promise((resolve) => raw.close(() => resolve())),
})

// A read-only stand-in for the app's database object: `query(sql)` resolves to [rows], as Sequelize's raw query does.
const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(standIn(raw))))
})

// A reader that records every statement, and answers no rows to those that match `hide`.
const logging = (database, hide = null) => {
  const statements = []
  const query = (sql) => {
    statements.push(sql)

    return hide && hide.test(sql) ? Promise.resolve([[]]) : database.query(sql)
  }

  return { statements, query }
}

// An in-memory database with the tables the loader reads, created from the module's own column list (less `omit`: a table name, or 'Table.Column') and filled with `data`: { Table: [row] }.
const memoryDatabase = async (mod, data, omit = []) => {
  const raw = await new Promise((resolve, reject) => {
    const created = new sqlite3.Database(':memory:', (error) => (error ? reject(error) : resolve(created)))
  })

  const optional = { FCT_GroundUnitFormationTemplate: ['Obsolete'] }

  for (const [table, required] of Object.entries(mod.GROUND_FORMATION_COLUMNS)) {
    const columns = [...required, ...(optional[table] || [])]

    if (omit.includes(table)) {
      continue
    }

    const kept = columns.filter((column) => !omit.includes(`${table}.${column}`))

    await runStatement(raw, `create table ${table} (${kept.join(', ')})`)

    for (const row of data[table] || []) {
      await runStatement(raw, `insert into ${table} (${kept.join(', ')}) values (${kept.map(() => '?').join(', ')})`, kept.map((column) => (row[column] === undefined ? null : row[column])))
    }
  }

  return { raw, database: standIn(raw) }
}

const memoryData = () => {
  const f = (FormationID, over = {}) => ({ FormationID, Name: `Memory ${FormationID}`, Abbreviation: `M${FormationID}`, RaceID: 7, GameID: 1, OriginalTemplateID: 0, ReplacementTemplateID: 0, PopulationID: 0, ShipID: 0, ParentFormationID: 0, ...over })
  const e = (ElementID, FormationID, ClassID, Units) => ({ ElementID, FormationID, ClassID, SpeciesID: 1, Units })

  return {
    FCT_GroundUnitFormation: [
      f(1, { PopulationID: 1, OriginalTemplateID: 21 }),
      f(2, { ShipID: 100, ParentFormationID: 1 }),
      f(4, { PopulationID: 1, ParentFormationID: 300 }),
      f(6, { PopulationID: 1, ParentFormationID: 999 }),
      f(7, { ShipID: 102, ParentFormationID: 1 }),
      f(300, { RaceID: 8, PopulationID: 1 }),
      f(400, { GameID: 2, PopulationID: 1 }),
    ],
    FCT_GroundUnitFormationElement: [e(1, 1, 10, 4), e(2, 2, 11, 2), e(3, 4, 10, 1), e(4, 6, 10, 1), e(5, 7, 10, 1), e(6, 300, 10, 100), e(7, 400, 10, 50)],
    FCT_GroundUnitClass: [groundClass(10, 'Infantry', 5), groundClass(11, 'Geo Survey', 100, 26)],
    DIM_GroundComponentType: [{ ComponentTypeID: 26, ComponentName: 'Geo', Geosurvey: 0.1, Xenoarchaeology: 0 }],
    FCT_GroundUnitFormationTemplate: [
      { TemplateID: 21, GameID: 2, RaceID: 7, Name: 'Other Game', Abbreviation: 'OG', Obsolete: 0 },
      { TemplateID: 21, GameID: 1, RaceID: 7, Name: 'Infantry Battalion', Abbreviation: 'IB', Obsolete: 0 },
    ],
    FCT_GroundUnitFormationElementTemplates: [
      { FormationTemplateID: 21, GameID: 2, ClassID: 10, Units: 99 },
      { FormationTemplateID: 21, GameID: 2, ClassID: 11, Units: 9 },
      { FormationTemplateID: 21, GameID: 1, ClassID: 10, Units: 4 },
    ],
    FCT_Ship: [
      { ShipID: 100, ShipName: 'Hauler', FleetID: 500, MothershipID: 0 },
      { ShipID: 102, ShipName: 'Lander', FleetID: 0, MothershipID: 100 },
      { ShipID: 103, ShipName: 'Idle', FleetID: 500, MothershipID: 0 },
    ],
    FCT_Fleet: [{ FleetID: 500, FleetName: 'Convoy', RaceID: 7, SystemID: 9, OrbitBodyID: 77 }],
    FCT_Population: [{ PopulationID: 1, PopName: 'Alpha Prime', RaceID: 7, SystemID: 50, SystemBodyID: 5 }],
    FCT_RaceSysSurvey: [
      { SystemID: 9, RaceID: 8, GameID: 1, Name: 'Other Name' },
      { SystemID: 9, RaceID: 7, GameID: 2, Name: 'Game Two' },
      { SystemID: 9, RaceID: 7, GameID: 1, Name: 'Alpha' },
      { SystemID: 50, RaceID: 7, GameID: 1, Name: 'Sol' },
    ],
  }
}

// Four formations whose rows lack inputs: a template id that is NULL, negative or not whole, a component slot that is NULL, and slots recorded empty (0 and -1).
const nullInputData = () => {
  const f = (FormationID, over = {}) => ({ FormationID, Name: `Null ${FormationID}`, Abbreviation: `N${FormationID}`, RaceID: 7, GameID: 1, OriginalTemplateID: 0, ReplacementTemplateID: 0, PopulationID: 1, ShipID: 0, ParentFormationID: 0, ...over })
  const e = (ElementID, FormationID, ClassID, Units) => ({ ElementID, FormationID, ClassID, SpeciesID: 1, Units })
  const c = (GroundUnitClassID, ClassName, Size, ComponentA, ComponentB = 0, ComponentC = 0, ComponentD = 0) => ({ GroundUnitClassID, ClassName, Size, ComponentA, ComponentB, ComponentC, ComponentD })

  return {
    FCT_GroundUnitFormation: [f(1, { OriginalTemplateID: null }), f(2, { ReplacementTemplateID: -1 }), f(3), f(4, { OriginalTemplateID: 2.5 })],
    FCT_GroundUnitFormationElement: [e(1, 1, 20, 5), e(2, 2, 21, 2), e(3, 3, 22, 4), e(4, 4, 10, 1)],
    FCT_GroundUnitClass: [c(10, 'Infantry', 5, 0), c(20, 'Null slot', 100, null), c(21, 'Half stored', 10, 26, null), c(22, 'Empty slots', 10, 26, 0, -1, 0)],
    DIM_GroundComponentType: [{ ComponentTypeID: 26, ComponentName: 'Geo', Geosurvey: 0.1, Xenoarchaeology: 0 }],
    FCT_Population: [{ PopulationID: 1, PopName: 'Alpha Prime', RaceID: 7, SystemID: 50, SystemBodyID: 5 }],
  }
}

const WRITES = /\b(insert|update|delete|drop|alter|create|attach|detach|vacuum|reindex|replace)\b|;/i
const STATEMENT_NAMES = ['classes', 'components', 'elements', 'fleets', 'formations', 'outsideParents', 'populations', 'ships', 'templateElements', 'templates']

// The results of the statement and loader checks on a module.
const databaseResults = async (mod) => {
  const results = []
  const add = async (id, name, fn) => {
    const outcome = await settle(fn)

    results.push({ id, name, ok: outcome.value === true, detail: outcome.error ? outcome.error.message : typeof outcome.value === 'string' ? outcome.value : '' })
  }

  await add('sql-select-only', 'every statement is one SELECT, names the game and race, and the set of statements is the one the builder takes', () => {
    const sql = mod.groundFormationSql({ GameID: 3, RaceID: 11 })

    return same(Object.keys(sql).sort(), STATEMENT_NAMES) && Object.values(sql).every((text) => /^select /.test(text) && !WRITES.test(text)) && sql.formations.includes('GameID = 3') && sql.formations.includes('RaceID = 11')
  })
  await add('sql-ids', 'game and race that are not whole numbers are refused', () => [{ GameID: 'x', RaceID: 1 }, { GameID: 1, RaceID: 1.5 }, { GameID: 1 }, { RaceID: 1 }, { GameID: '1; drop table x', RaceID: 1 }].every((ids) => {
    try {
      mod.groundFormationSql(ids)

      return false
    } catch (error) {
      return error instanceof TypeError
    }
  }))

  const { raw, database } = await memoryDatabase(mod, memoryData())
  const logged = logging(database)
  const loaded = await settle(() => mod.loadGroundFormations(logged, { GameID: 1, RaceID: 7 }))
  const m = loaded.value
  const node = (id) => m.byId.get(id)

  await add('memory-ids', 'the loader reads the formations of the race and game only', () => m.supported === true && same(m.formations.map((item) => item.id), [1, 2, 4, 6, 7]))
  await add('memory-scope', 'no row of another race or game is read, and no element of one', () => m.summary.excluded === 0 && m.summary.strayElements === 0 && m.summary.duplicateRows === 0)
  await add('memory-select-only', 'every statement the loader runs is a SELECT', () => logged.statements.length >= 20 && logged.statements.every((text) => /^select /.test(text) && !WRITES.test(text)))
  await add('memory-location', 'a ship formation takes the system name of the race, in the game, from the fleet or the carrying ship', () => same(node(2).location.system, { id: 9, name: 'Alpha' }) && node(2).location.fleet.via === 'ship' && same(node(7).location.system, { id: 9, name: 'Alpha' }) && node(7).location.fleet.via === 'mothership' && same(node(1).location.system, { id: 50, name: 'Sol' }))
  await add('memory-parents', 'a parent of another race is foreign, one that is nowhere is an orphan', () => node(4).parent.state === 'foreign' && node(4).parent.raceId === 8 && node(6).parent.state === 'orphan')
  await add('memory-templates', 'the template is the one of the game with the composition of the game', () => node(1).templates.original.state === 'found' && node(1).templates.original.name === 'Infantry Battalion' && node(1).templates.original.obsolete === false && same(node(1).templates.original.elements, [{ classId: 10, className: 'Infantry', units: 4 }]) && node(1).templates.replacement.state === 'none')
  await add('memory-figures', 'the totals are those of the rows of the race', () => m.summary.mass.value === 235 && near(node(2).geo.value, 0.2) && m.summary.units.value === 9 && m.summary.elements === 5)

  await new Promise((resolve) => raw.close(() => resolve()))

  const lacking = await memoryDatabase(mod, memoryData(), ['FCT_GroundUnitFormation.ReplacementTemplateID'])
  const lackingLog = logging(lacking.database)
  const unsupported = await settle(() => mod.loadGroundFormations(lackingLog, { GameID: 1, RaceID: 7 }))
  const noTable = await memoryDatabase(mod, memoryData(), ['FCT_RaceSysSurvey'])
  const noTableLog = logging(noTable.database)
  const unsurveyed = await settle(() => mod.loadGroundFormations(noTableLog, { GameID: 1, RaceID: 7 }))

  await add('unsupported', 'a save that lacks a column or a table is unsupported, names it, and no data is read', () => unsupported.value.supported === false && unsupported.value.missing.includes('FCT_GroundUnitFormation.ReplacementTemplateID') && unsupported.value.formations === undefined && lackingLog.statements.every((text) => text.startsWith('select name from pragma_table_info')) && unsurveyed.value.supported === false && same(unsurveyed.value.missing, ['FCT_RaceSysSurvey']) && noTableLog.statements.every((text) => text.startsWith('select name from pragma_table_info')))

  await new Promise((resolve) => lacking.raw.close(() => resolve()))
  await new Promise((resolve) => noTable.raw.close(() => resolve()))

  const earlier = await memoryDatabase(mod, memoryData(), ['FCT_GroundUnitFormationTemplate.Obsolete'])
  const earlierLog = logging(earlier.database)
  const read = await settle(() => mod.loadGroundFormations(earlierLog, { GameID: 1, RaceID: 7 }))

  await add('obsolete-optional', 'a save without the template Obsolete column is read, the figure unknown', () => read.value.supported === true && read.value.byId.get(1).templates.original.state === 'found' && read.value.byId.get(1).templates.original.obsolete === null && read.value.summary.mass.value === 235)

  await new Promise((resolve) => earlier.raw.close(() => resolve()))

  const nulls = await memoryDatabase(mod, nullInputData())
  const nullModel = (await settle(() => mod.loadGroundFormations(logging(nulls.database), { GameID: 1, RaceID: 7 }))).value
  const tamperModel = (await settle(() => mod.loadGroundFormations(logging(nulls.database), { GameID: 1, RaceID: 7 }))).value
  const nullNode = (id) => nullModel.byId.get(id)
  const nullKinds = (id) => nullNode(id).problems.map((problem) => problem.kind)

  await add('memory-null-slots', 'a component slot that is not stored makes geosurvey and xenoarchaeology unknown, names the slot and keeps the mass; slots recorded empty add nothing', () => nullModel.supported === true && nullNode(1).mass.value === 500 && nullNode(1).geo.value === null && nullNode(1).xeno.value === null && nullNode(1).geo.unknown.length === 1 && nullKinds(1).includes('component-unknown') && nullNode(1).problems.find((problem) => problem.kind === 'component-unknown').slot === 'ComponentA' && nullNode(2).mass.value === 20 && nullNode(2).geo.value === null && nullNode(2).problems.find((problem) => problem.kind === 'component-unknown').slot === 'ComponentB' && near(nullNode(3).geo.value, 0.4) && nullNode(3).xeno.value === 0 && !nullKinds(3).includes('component-unknown') && near(nullModel.summary.geo.value, 0.4) && nullModel.summary.geo.unknownFormations === 2 && nullModel.summary.xeno.value === 0 && nullModel.summary.xeno.unknownFormations === 2 && nullModel.summary.mass.value === 565 && nullModel.summary.mass.unknownFormations === 0)
  await add('memory-null-templates', 'a template id that is not stored is unknown with a problem and its own count, apart from the recorded 0, which stays none', () => nullNode(1).templates.original.state === 'unknown' && nullNode(1).templates.replacement.state === 'none' && nullNode(2).templates.replacement.state === 'unknown' && nullNode(2).templates.replacement.id === -1 && nullNode(4).templates.original.state === 'unknown' && nullNode(3).templates.original.state === 'none' && nullNode(3).templates.original.id === 0 && nullKinds(1).includes('template-unknown') && !nullKinds(3).some((kind) => kind.startsWith('template-')) && same(nullModel.summary.templates.unknown, { original: 2, replacement: 1 }) && same(nullModel.summary.templates.none, { original: 2, replacement: 3 }) && same(nullModel.summary.templates.found, { original: 0, replacement: 0 }) && same(nullModel.summary.templates.missing, { original: 0, replacement: 0 }))
  await add('oracle-null-inputs', 'the direct comparison agrees with the loader on a slot or template id that is not stored, and fails when the loader reads the slot as empty or the id as none', async () => {
    const honest = await reconcile(nulls.database, nullModel, [], 1, 7, mod)
    const templates = nullModel.summary.templates
    const asNone = { ...tamperModel, summary: { ...tamperModel.summary, templates: { ...templates, none: { original: templates.none.original + templates.unknown.original, replacement: templates.none.replacement + templates.unknown.replacement }, unknown: { original: 0, replacement: 0 } } } }
    const noneResults = await reconcile(nulls.database, asNone, [], 1, 7, mod)

    tamperModel.byId.get(1).geo = { value: 0, from: [], unknown: [] }

    const emptyResults = await reconcile(nulls.database, tamperModel, [], 1, 7, mod)

    return honest.every((result) => result.ok) && noneResults.some((result) => !result.ok && result.name.includes('template states')) && emptyResults.some((result) => !result.ok && result.name.includes('geosurvey'))
  })

  await new Promise((resolve) => nulls.raw.close(() => resolve()))

  return results
}

// The ids of the checks of every group that fail on a module; a module that makes a group throw fails with `crash`.
const failedIds = async (mod) => {
  try {
    return [...(await builderResults(mod)), ...(await databaseResults(mod))].filter((result) => !result.ok).map((result) => result.id)
  } catch {
    return ['crash']
  }
}

const DIRECT_SLOTS = ['ComponentA', 'ComponentB', 'ComponentC', 'ComponentD']
const DIRECT_ALIASES = ['sa', 'sb', 'sc', 'sd']

// Figures worked out from the tables in SQL written here, apart from the module's: a row of the result per formation that has elements.
const directFigures = (GameID, RaceID) => {
  const slotSum = (key) => DIRECT_ALIASES.map((alias) => `coalesce(${alias}.${key}, 0)`).join(' + ')
  const slotBad = (key) => DIRECT_SLOTS.map((slot, index) => `(typeof(c.${slot}) not in ('integer', 'real') or (c.${slot} > 0 and ${DIRECT_ALIASES[index]}.${key} is null))`).join(' or ')
  const joins = DIRECT_SLOTS.map((slot, index) => `left join DIM_GroundComponentType ${DIRECT_ALIASES[index]} on ${DIRECT_ALIASES[index]}.ComponentTypeID = c.${slot}`).join(' ')
  const base = 'c.GroundUnitClassID is null or e.Units is null or e.Units < 0'

  return `select e.FormationID as id, count(*) as n, sum(e.Units * c.Size) as mass, sum(case when ${base} or c.Size is null or c.Size < 0 then 1 else 0 end) as massBad, sum(e.Units * (${slotSum('Geosurvey')})) as geo, sum(case when ${base} or ${slotBad('Geosurvey')} then 1 else 0 end) as geoBad, sum(e.Units * (${slotSum('Xenoarchaeology')})) as xeno, sum(case when ${base} or ${slotBad('Xenoarchaeology')} then 1 else 0 end) as xenoBad from FCT_GroundUnitFormationElement e left join FCT_GroundUnitClass c on c.GroundUnitClassID = e.ClassID ${joins} where e.FormationID in (select FormationID from FCT_GroundUnitFormation where GameID = ${GameID} and RaceID = ${RaceID}) group by e.FormationID`
}

const firstDifference = (ids, agrees) => {
  const at = ids.find((id) => !agrees(id))

  return at === undefined ? '' : `first at formation ${at}`
}

// The model of a game and race compared with the save in SQL written here: [{ name, ok, detail }].
const reconcile = async (database, model, statements, GameID, RaceID, mod) => {
  const q = async (sql) => (await database.query(sql))[0]
  const own = `select FormationID from FCT_GroundUnitFormation where GameID = ${GameID} and RaceID = ${RaceID}`
  const rows = await q(`select FormationID, ParentFormationID, OriginalTemplateID, ReplacementTemplateID, PopulationID, ShipID from FCT_GroundUnitFormation where GameID = ${GameID} and RaceID = ${RaceID}`)
  const ids = rows.map((row) => row.FormationID)
  const idSet = new Set(ids)
  const results = []
  const add = (name, ok, detail = '') => results.push({ name, ok: ok === true, detail })
  const s = model.summary
  const node = (id) => model.byId.get(id)

  add('the formations are the rows of the race, each once', model.formations.length === ids.length && same(sorted(model.formations.map((item) => item.id)), sorted(ids)) && model.formations.every((item) => idSet.has(item.id)) && s.formations === ids.length)
  add('nothing is excluded, stray or repeated', s.excluded === 0 && s.strayElements === 0 && s.duplicateRows === 0, `excluded ${s.excluded}, stray ${s.strayElements}, repeated ${s.duplicateRows}`)

  const [elementTotals] = await q(`select count(*) as n, sum(case when Units >= 0 then Units else 0 end) as units, sum(case when Units is null or Units < 0 then 1 else 0 end) as unknown from FCT_GroundUnitFormationElement where FormationID in (${own})`)

  add('element rows and units add up to the rows', s.elements === elementTotals.n && near(s.units.value, elementTotals.units || 0) && s.units.unknownElements === (elementTotals.unknown || 0), `model ${s.elements} elements, ${s.units.value} units; save ${elementTotals.n}, ${elementTotals.units}`)

  const figureRows = new Map((await q(directFigures(GameID, RaceID))).map((row) => [row.id, row]))
  const expected = (id, kind) => {
    const row = figureRows.get(id)

    return row && !row[`${kind}Bad`] ? row[kind] : null
  }
  const agrees = (kind) => (id) => {
    const want = expected(id, kind)
    const got = node(id) ? node(id)[kind].value : undefined

    return want === null ? got === null : got !== null && got !== undefined && near(got, want)
  }

  add('mass of each formation is its elements\' size times units', ids.every(agrees('mass')), firstDifference(ids, agrees('mass')))
  add('geosurvey of each formation is the rating of its elements\' equipment', ids.every(agrees('geo')), firstDifference(ids, agrees('geo')))
  add('xenoarchaeology of each formation is the rating of its elements\' equipment', ids.every(agrees('xeno')), firstDifference(ids, agrees('xeno')))

  const totalsAgree = ['mass', 'geo', 'xeno'].every((kind) => {
    const known = ids.filter((id) => expected(id, kind) !== null)

    return near(s[kind].value, known.reduce((sum, id) => sum + expected(id, kind), 0)) && s[kind].unknownFormations === ids.length - known.length
  })

  add('the race totals add the known formations and count the unknown ones', totalsAgree && model.roots.reduce((sum, id) => sum + node(id).tree.formations, 0) === ids.length && ['mass', 'geo', 'xeno'].every((kind) => near(model.roots.reduce((sum, id) => sum + node(id).tree[kind].value, 0), s[kind].value) && model.roots.reduce((sum, id) => sum + node(id).tree[kind].unknownFormations, 0) === s[kind].unknownFormations))
  add('every figure lists the elements behind it', traced(model))
  add('no formation has no elements unless the save has none for it', s.noElements === ids.filter((id) => !figureRows.has(id)).length && ids.every((id) => (node(id).elements.length > 0) === figureRows.has(id)))

  const [parents] = await q(`select sum(case when f.ParentFormationID > 0 and not exists (select 1 from FCT_GroundUnitFormation p where p.FormationID = f.ParentFormationID) then 1 else 0 end) as orphans, sum(case when f.ParentFormationID > 0 and exists (select 1 from FCT_GroundUnitFormation p where p.FormationID = f.ParentFormationID) and not exists (select 1 from FCT_GroundUnitFormation p where p.FormationID = f.ParentFormationID and p.GameID = ${GameID} and p.RaceID = ${RaceID}) then 1 else 0 end) as foreign_, sum(case when f.ParentFormationID is null or f.ParentFormationID < 0 then 1 else 0 end) as unknown from FCT_GroundUnitFormation f where f.GameID = ${GameID} and f.RaceID = ${RaceID}`)

  add('orphan, foreign and unknown parents are those the rows give', s.orphans === (parents.orphans || 0) && s.foreignParents === (parents.foreign_ || 0) && s.unknownParents === (parents.unknown || 0), `model ${s.orphans}/${s.foreignParents}/${s.unknownParents}, save ${parents.orphans}/${parents.foreign_}/${parents.unknown}`)

  const parentOf = new Map(rows.filter((row) => idSet.has(row.ParentFormationID)).map((row) => [row.FormationID, row.ParentFormationID]))
  const onLoop = ids.filter((id) => {
    let at = parentOf.get(id)

    for (let step = 0; at !== undefined && step <= ids.length; step++) {
      if (at === id) {
        return true
      }

      at = parentOf.get(at)
    }

    return false
  })

  add('the loops are those found by following the parents', same(sorted(model.cycles.flatMap((cycle) => cycle.members)), sorted(onLoop)) && s.cycleMembers === onLoop.length && model.cycles.every((cycle) => cycle.cutAt === Math.min(...cycle.members)), `${onLoop.length} formations on loops`)
  add('every formation is under exactly one top-level entry', partitioned(model))

  const stateCount = async (column) => {
    const valid = `(typeof(f.${column}) in ('integer', 'real') and f.${column} = cast(f.${column} as integer))`
    const [row] = await q(`select sum(case when ${valid} and f.${column} > 0 and not exists (select 1 from FCT_GroundUnitFormationTemplate t where t.TemplateID = f.${column} and t.GameID = ${GameID}) then 1 else 0 end) as missing, sum(case when ${valid} and f.${column} > 0 and exists (select 1 from FCT_GroundUnitFormationTemplate t where t.TemplateID = f.${column} and t.GameID = ${GameID}) and not exists (select 1 from FCT_GroundUnitFormationTemplate t where t.TemplateID = f.${column} and t.GameID = ${GameID} and t.RaceID = ${RaceID}) then 1 else 0 end) as foreign_, sum(case when ${valid} and f.${column} = 0 then 1 else 0 end) as none, sum(case when ${valid} and f.${column} >= 0 then 0 else 1 end) as unknown from FCT_GroundUnitFormation f where f.GameID = ${GameID} and f.RaceID = ${RaceID}`)

    return { missing: row.missing || 0, foreign: row.foreign_ || 0, none: row.none || 0, unknown: row.unknown || 0 }
  }
  const original = await stateCount('OriginalTemplateID')
  const replacement = await stateCount('ReplacementTemplateID')
  const wanted = (state) => ({ original: original[state], replacement: replacement[state] })

  add('template states are those the rows give', same(s.templates.missing, wanted('missing')) && same(s.templates.foreign, wanted('foreign')) && same(s.templates.none, wanted('none')) && same(s.templates.unknown, wanted('unknown')) && s.templates.found.original === ids.length - original.missing - original.foreign - original.none - original.unknown && s.templates.found.replacement === ids.length - replacement.missing - replacement.foreign - replacement.none - replacement.unknown, `model missing ${JSON.stringify(s.templates.missing)} unknown ${JSON.stringify(s.templates.unknown)}, save ${JSON.stringify(wanted('missing'))} ${JSON.stringify(wanted('unknown'))}`)

  const compositions = new Map((await q(`select FormationTemplateID as id, count(*) as n, sum(case when Units >= 0 then Units else 0 end) as units from FCT_GroundUnitFormationElementTemplates where GameID = ${GameID} group by FormationTemplateID`)).map((row) => [row.id, row]))
  const compositionAgrees = (id) => ['original', 'replacement'].every((which) => {
    const template = node(id).templates[which]

    if (template.state !== 'found') {
      return template.elements === null
    }

    const row = compositions.get(template.id) || { n: 0, units: 0 }

    return template.elements.length === row.n && near(template.elements.reduce((sum, item) => sum + (item.units ?? 0), 0), row.units || 0)
  })

  add('a found template carries its composition', ids.every(compositionAgrees), firstDifference(ids, compositionAgrees))

  const colonies = new Map((await q(`select f.FormationID as id, p.SystemID as systemId from FCT_GroundUnitFormation f join FCT_Population p on p.PopulationID = f.PopulationID where f.GameID = ${GameID} and f.RaceID = ${RaceID} and f.PopulationID > 0`)).map((row) => [row.id, row.systemId]))
  const ships = new Map((await q(`select f.FormationID as id, coalesce(fl.SystemID, fm.SystemID) as systemId from FCT_GroundUnitFormation f join FCT_Ship s on s.ShipID = f.ShipID left join FCT_Fleet fl on fl.FleetID = s.FleetID left join FCT_Ship ms on ms.ShipID = s.MothershipID left join FCT_Fleet fm on fm.FleetID = ms.FleetID where f.GameID = ${GameID} and f.RaceID = ${RaceID} and coalesce(f.PopulationID, 0) <= 0 and f.ShipID > 0`)).map((row) => [row.id, row.systemId]))
  const systemOf = (id) => {
    const found = colonies.has(id) ? colonies.get(id) : ships.get(id)

    return found > 0 ? found : null
  }
  const locationAgrees = (id) => (node(id).location.system ? node(id).location.system.id : null) === systemOf(id)
  const resolvedColonies = ids.filter((id) => colonies.has(id) && systemOf(id) !== null).length
  const resolvedShips = ids.filter((id) => !colonies.has(id) && ships.has(id) && systemOf(id) !== null).length

  add('the system of each formation is that of its colony, or of the fleet of its ship', ids.every(locationAgrees) && s.locations.colony === resolvedColonies && s.locations.ship === resolvedShips && s.locations.unresolved === ids.length - resolvedColonies - resolvedShips, `${firstDifference(ids, locationAgrees)}; model ${JSON.stringify(s.locations)}, save ${resolvedColonies}/${resolvedShips}`)

  const named = new Set((await q(`select SystemID from FCT_RaceSysSurvey where GameID = ${GameID} and RaceID = ${RaceID} and Name is not null and Name != ''`)).map((row) => row.SystemID))
  const colonyRaces = new Map((await q(`select f.FormationID as id, p.RaceID as raceId from FCT_GroundUnitFormation f join FCT_Population p on p.PopulationID = f.PopulationID where f.GameID = ${GameID} and f.RaceID = ${RaceID} and f.PopulationID > 0`)).map((row) => [row.id, row.raceId]))
  const stored = new Map(rows.map((row) => [row.FormationID, row]))
  const remoteOf = (id) => (stored.get(id).PopulationID > 0 ? (colonyRaces.has(id) ? colonyRaces.get(id) !== RaceID : null) : true)
  const namedSystem = (id) => (systemOf(id) !== null && named.has(systemOf(id)) ? systemOf(id) : null)
  const placeOf = (id) => mod.formationPlace(node(id), model)
  const remoteIds = ids.filter((id) => remoteOf(id) === true)
  const remoteAgrees = (id) => placeOf(id).remote === remoteOf(id)
  const systemAgrees = (id) => (placeOf(id).system ? placeOf(id).system.id : null) === namedSystem(id)

  add('a formation is remote when no colony of the race holds it, and not known to be when its colony is not in the save', ids.every(remoteAgrees), firstDifference(ids, remoteAgrees))
  add('a formation has a system only where the race stores its survey name', ids.every(systemAgrees), firstDifference(ids, systemAgrees))

  const grouped = mod.groupBySystem(model, (_node, place) => place.remote === true)
  const wantSystems = new Map()

  remoteIds.filter((id) => namedSystem(id) !== null).forEach((id) => wantSystems.set(namedSystem(id), [...(wantSystems.get(namedSystem(id)) || []), id]))

  const wantUnplaced = remoteIds.filter((id) => namedSystem(id) === null)
  const groupedSystems = Object.values(grouped.systems)

  add('the remote formations by system are those the rows give, each once, with none in a system the race does not name', same(sorted(groupedSystems.map((entry) => entry.id)), sorted(Array.from(wantSystems.keys()))) && groupedSystems.every((entry) => same(sorted(entry.formations), sorted(wantSystems.get(entry.id)))) && same(sorted(grouped.unplaced.map((entry) => entry.id)), sorted(wantUnplaced)) && grouped.formations === remoteIds.length && groupedSystems.reduce((sum, entry) => sum + entry.formations.length, 0) + grouped.unplaced.length === remoteIds.length, `${groupedSystems.length} systems and ${grouped.unplaced.length} unplaced, save ${wantSystems.size} and ${wantUnplaced.length}`)

  const totalsOf = (list) => {
    const pairs = list.map((id) => [expected(id, 'geo'), expected(id, 'xeno')])
    const geo = (pair) => pair[0] > 0
    const xeno = (pair) => pair[1] > 0
    const other = (pair) => pair[0] === 0 && pair[1] === 0

    return { formations: list.length, geo: pairs.filter(geo).length, xeno: pairs.filter(xeno).length, other: pairs.filter(other).length, both: pairs.filter((pair) => geo(pair) && xeno(pair)).length, unknown: pairs.filter((pair) => !geo(pair) && !xeno(pair) && !other(pair)).length }
  }
  const adds = (totals) => totals.geo + totals.xeno - totals.both + totals.other + totals.unknown === totals.formations
  const allTotals = mod.roleTotals(model)
  const remoteTotals = mod.roleTotals(model, (_node, place) => place.remote === true)

  add('the role totals are those of the ratings and add up to the formations, a formation with both ratings once', same(allTotals, totalsOf(ids)) && adds(allTotals), `model ${JSON.stringify(allTotals)}, save ${JSON.stringify(totalsOf(ids))}`)
  add('the role totals of the remote formations are those of the ratings and add up to them', same(remoteTotals, totalsOf(remoteIds)) && adds(remoteTotals), `model ${JSON.stringify(remoteTotals)}, save ${JSON.stringify(totalsOf(remoteIds))}`)
  add('every statement the loader ran is a SELECT', statements.every((text) => /^select /.test(text) && !WRITES.test(text)))

  return results
}

const BLIND_READERS = [
  ['the elements', /^select FCT_GroundUnitFormationElement\.rowid/, (model) => model.summary.elements > 0],
  ['the ships', /^select FCT_Ship\.ShipID/, (model) => model.summary.locations.ship > 0],
  ['the fleets', /^select FCT_Fleet\.FleetID/, (model) => model.summary.locations.ship > 0],
  ['the colonies', /^select FCT_Population\.PopulationID/, (model) => model.summary.locations.colony > 0],
  ['the templates', /^select FCT_GroundUnitFormationTemplate\.TemplateID/, (model) => model.summary.templates.found.original + model.summary.templates.found.replacement > 0],
]

const infoLine = (label, model) => {
  const s = model.summary
  const pair = (counts) => `${counts.original}/${counts.replacement}`
  const rounded = (value) => Number(value.toFixed(6))

  console.log(`INFO  ${label}: ${s.formations} formations, ${s.roots} roots (${s.topLevel} top-level), orphans ${s.orphans}, foreign parents ${s.foreignParents}, cycles ${s.cycles} (${s.cycleMembers} members), templates missing ${pair(s.templates.missing)} foreign ${pair(s.templates.foreign)} unknown ${pair(s.templates.unknown)} none ${pair(s.templates.none)} (original/replacement), no elements ${s.noElements}, locations ${s.locations.colony} colony + ${s.locations.ship} ship + ${s.locations.unresolved} unresolved, ${s.elements} elements, ${s.units.value} units, mass ${rounded(s.mass.value)} (${s.mass.unknownFormations} unknown), geo ${rounded(s.geo.value)} (${s.geo.unknownFormations} unknown), xeno ${rounded(s.xeno.value)} (${s.xeno.unknownFormations} unknown)`)
}

const OWNER_SAVES = [
  ['AuroraDB.db', 140, 784, true],
  ['saves/AuroraDB_271_skoormit_saved.db', 138, 785, true],
  ...['2398452450', '2590429565', '2713949950', '2740177930', '2794985390', '2810693885', '2904201340', '2930673230'].map((time) => [`artifacts/falryx-sequential-and-rollback/AuroraDB-${time}.db`, 141, 791, false]),
  ...['5.03.1940', '20.07.1956', '8.05.1961', '24.12.1962', '21.06.1973'].map((date) => [`artifacts/boscodiogigia-sequential-saves/AuroraDB ${date}.db`, 140, 784, false]),
]

const ownerSave = async (mod, [file, GameID, RaceID, selfChecks]) => {
  const label = `${file} (game ${GameID}, race ${RaceID})`

  console.log(`\n${label}`)

  const database = await openSave(file)

  if (!database) {
    skippedSaves++
    console.log(`SKIP  ${file} is not there`)

    return
  }

  try {
    const logged = logging(database)
    const model = await mod.loadGroundFormations(logged, { GameID, RaceID })

    if (!model.supported) {
      unsupportedSaves++
      console.log(`UNSUPPORTED  ${file} lacks ${model.missing.join(', ')}`)

      return
    }

    if (!model.summary.formations) {
      emptySaves++
      console.log(`EMPTY  ${file} has no formation of this game and race`)

      return
    }

    infoLine(label, model)

    const results = await reconcile(database, model, logged.statements, GameID, RaceID, mod)

    if (selfChecks) {
      results.forEach((result) => check(`${file}: ${result.name}`, result.ok, result.detail))
    } else {
      const failed = results.filter((result) => !result.ok)

      check(`${file}: ${results.length} comparisons with the save agree`, failed.length === 0, failed.map((result) => `${result.name}${result.detail ? `: ${result.detail}` : ''}`).join('; '))
    }

    if (selfChecks) {
      for (const [what, hide, applies] of BLIND_READERS) {
        if (applies(model)) {
          const blind = await mod.loadGroundFormations(logging(database, hide), { GameID, RaceID })
          const results = await reconcile(database, blind, [], GameID, RaceID, mod)

          check(`${file}: self-check: with ${what} hidden the comparison fails`, results.some((result) => !result.ok))
        }
      }
    }
  } finally {
    await database.close()
  }
}

const breadthFiles = () => {
  const listing = (directory) => (fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => /^AuroraDB.*\.db$/i.test(name)).sort().map((name) => path.join(directory, name)) : [])
  const artifacts = path.join(root, 'artifacts')
  const folders = fs.existsSync(artifacts) ? fs.readdirSync(artifacts, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(artifacts, entry.name)).sort() : []

  return [root, path.join(root, 'saves'), ...folders].flatMap(listing)
}

const breadthSave = async (mod, file, covered) => {
  const shown = path.relative(root, file).replace(/\\/g, '/')
  const database = await openSave(file)

  try {
    const probe = await mod.loadGroundFormations(database, { GameID: 0, RaceID: 0 })

    if (!probe.supported) {
      unsupportedSaves++
      console.log(`UNSUPPORTED  ${shown} lacks ${probe.missing.join(', ')}`)

      return
    }

    const [pairs] = await database.query('select GameID, RaceID, count(*) as n from FCT_GroundUnitFormation group by GameID, RaceID order by GameID, RaceID')

    if (!pairs.length) {
      emptySaves++
      console.log(`EMPTY  ${shown} has no formation row`)

      return
    }

    for (const { GameID, RaceID, n } of pairs) {
      if (covered.has(`${path.resolve(file)}|${GameID}|${RaceID}`)) {
        continue
      }

      if (!Number.isInteger(GameID) || !Number.isInteger(RaceID)) {
        skippedSaves++
        console.log(`SKIP  ${shown}: ${n} formation rows with a game or race that is not a whole number`)

        continue
      }

      const logged = logging(database)
      const model = await mod.loadGroundFormations(logged, { GameID, RaceID })
      const results = await reconcile(database, model, logged.statements, GameID, RaceID, mod)
      const failed = results.filter((result) => !result.ok)

      const s = model.summary

      if (s.orphans + s.foreignParents + s.unknownParents + s.cycles + s.noElements + s.locations.unresolved + s.templates.missing.original + s.templates.missing.replacement + s.templates.foreign.original + s.templates.foreign.replacement + s.templates.unknown.original + s.templates.unknown.replacement > 0) {
        infoLine(`${shown} game ${GameID} race ${RaceID}`, model)
      }

      check(`${shown}: game ${GameID} race ${RaceID} (${n} formations) agrees with the save`, failed.length === 0, failed.map((result) => `${result.name}${result.detail ? `: ${result.detail}` : ''}`).join('; '))
    }
  } catch (error) {
    check(`${shown}: reads`, false, error.message)
  } finally {
    await database.close()
  }
}

const unhashed = (text) => text.replace(/#\{/g, '$' + '{')

// A copy of the utilities folder in the temp folder in which `file` has `from`, found exactly once, replaced by `to`.
const mutatedCopy = (from, to) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-formation-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, FILE)
  const source = fs.readFileSync(target, 'utf8')
  const occurrences = source.split(from).length - 1

  if (occurrences !== 1) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw new Error(`The mutation does not apply to ${FILE} (${occurrences} occurrences): ${from}`)
  }

  fs.writeFileSync(target, source.replace(from, () => to))

  return directory
}

const MUTANTS = [
  ['an orphan parent is made a root', 'parent = { id: raw, state: \'orphan\' }', 'parent = { id: null, state: \'none\' }', ['orphan', 'roots', 'parents', 'problems']],
  ['loops are not looked for', 'const cycles = findCycles(parentOf).map(', 'const cycles = [].map(', ['cycle', 'partition', 'roots']],
  ['a loop is not cut', 'const cut = new Set(cycles.map((cycle) => cycle.cutAt))', 'const cut = new Set()', ['partition', 'roots', 'cycle']],
  ['mass ignores units', 'value += item.units * per', 'value += per', ['mass', 'trace', 'tree']],
  ['a formation with no elements weighs 0', 'const noElements = () => ({ value: null,', 'const noElements = () => ({ value: 0,', ['unknown', 'mass', 'trace']],
  ['a missing class weighs 0', 'unknown.push({ elementId: item.id, classId: item.classId, reason: \'the class is not stored\' })', 'value += 0', ['unknown', 'mass', 'trace']],
  ['unknown units weigh 0', 'units: isCount(row.Units) ? row.Units : null', 'units: isCount(row.Units) ? row.Units : 0', ['unknown', 'units', 'problems']],
  ['rows of another race are kept', 'if (row.RaceID !== RaceID || row.GameID !== GameID) {', 'if (false) {', ['filter', 'mass']],
  ['stray elements are not counted', 'strayElements++', 'strayElements += 0', ['filter']],
  ['a repeated row is kept', '} else if (seenIds.has(row.FormationID)) {', '} else if (false) {', ['duplicates']],
  ['the fleet of a ship is ignored', 'let fleet = isId(ship.FleetID) ? fleets.get(ship.FleetID) : undefined', 'let fleet', ['location-ship', 'location-follows-fleet', 'memory-location']],
  ['a carried ship does not follow its carrier', 'if (!fleet && mothership && isId(mothership.FleetID) && fleets.get(mothership.FleetID)) {', 'if (false) {', ['location-fallback', 'memory-location']],
  ['a missing template is none', 'return { id, state: \'missing\', name: null,', 'return { id, state: \'none\', name: null,', ['templates', 'problems']],
  ['a template of another race is found', 'if (row.RaceID !== RaceID) {', 'if (false) {', ['templates', 'problems']],
  ['a template carries no composition', 'elements: (templateElements.get(id) || []).map(', 'elements: [].map(', ['templates', 'memory-templates']],
  ['geosurvey reads the xenoarchaeology rating', 'geo: figure(items, classes, figures, \'geo\')', 'geo: figure(items, classes, figures, \'xeno\')', ['geo-xeno', 'trace', 'unknown']],
  ['an equipment that is not catalogued rates 0', 'if (!component || !isNumber(component[key])) {', 'if (!component) {\n        return\n      }\n\n      if (!isNumber(component[key])) {', ['unknown', 'geo-xeno', 'problems']],
  ['the tree does not add its children', 'up[kind].value += node.tree[kind].value', 'up[kind].value += 0', ['tree']],
  ['depth stops at one', 'child.depth = node.depth + 1', 'child.depth = 1', ['depth']],
  ['the formations below an orphan are resolved', 'child.resolved = node.resolved', 'child.resolved = true', ['unresolved']],
  ['the statement for the formations is not scoped to the race', unhashed('FCT_GroundUnitFormation.GameID = #{g} and FCT_GroundUnitFormation.RaceID = #{r} order by'), unhashed('FCT_GroundUnitFormation.GameID = #{g} order by'), ['memory-scope', 'memory-ids']],
  ['the statement for the elements is not scoped to the race', unhashed('where FCT_GroundUnitFormationElement.FormationID in (#{OWN(g, r)}) order by'), 'order by', ['memory-scope', 'memory-figures']],
  ['the statement for the templates is not scoped to the game', unhashed('where FCT_GroundUnitFormationTemplate.GameID = #{g} and FCT_GroundUnitFormationTemplate.TemplateID in'), 'where FCT_GroundUnitFormationTemplate.TemplateID in', ['memory-templates']],
  ['the statement for the template elements is not scoped to the game', unhashed('FCT_GroundUnitFormationElementTemplates.GameID = #{g} and FCT_GroundUnitFormationElementTemplates.FormationTemplateID in (#{OWN_TEMPLATES(g, r)})`,'), unhashed('FCT_GroundUnitFormationElementTemplates.FormationTemplateID in (#{OWN_TEMPLATES(g, r)})`,'), ['memory-templates']],
  ['a save without the columns is read anyway', 'if (missing.length) {', 'if (false) {', ['unsupported']],
  ['a save without the Obsolete column is required to have it', 'const obsolete = (await columnsOf(database, \'FCT_GroundUnitFormationTemplate\')).has(\'Obsolete\')', 'const obsolete = true', ['obsolete-optional']],
  ['an unstored component slot counts as an empty slot', 'known = false\n        note({ kind: \'component-unknown\'', 'note({ kind: \'component-unknown\'', ['memory-null-slots']],
  ['an unstored component slot raises no problem', 'note({ kind: \'component-unknown\', slot, componentId: null, reason: \'the component of the slot is not stored\' })', 'void 0', ['memory-null-slots']],
  ['an unstored template id is none', 'state: \'unknown\', name: null, abbreviation: null, obsolete: null, elements: null }', 'state: \'none\', name: null, abbreviation: null, obsolete: null, elements: null }', ['memory-null-templates']],
  ['an unstored template id raises no problem', '} else if (refs[which].state === \'unknown\') {', '} else if (false) {', ['memory-null-templates']],
  ['a template id of 0 is not none', 'if (id === 0) {', 'if (false) {', ['templates', 'memory-null-templates']],
  ['a formation is placed in a system the race has no name for', 'const named = Boolean(location.system) && typeof location.system.name === \'string\' && location.system.name !== \'\'', 'const named = Boolean(location.system)', ['place-system', 'place-unresolved', 'group-system', 'group-reconcile']],
  ['every formation is remote', 'location.kind === \'colony\' ? (Number.isInteger(owner) ? owner !== RaceID : null) : true', 'true', ['place']],
  ['a formation aboard a ship is not remote', 'location.kind === \'colony\' ? (Number.isInteger(owner) ? owner !== RaceID : null) : true', 'location.kind === \'ship\' ? false : location.kind === \'colony\' ? (Number.isInteger(owner) ? owner !== RaceID : null) : true', ['place']],
  ['a formation of a colony with an unstored race is remote', 'Number.isInteger(owner) ? owner !== RaceID : null', 'Number.isInteger(owner) ? owner !== RaceID : true', ['place']],
  ['a formation with two roles is grouped once per role', 'entry.formations.push(node.id)', 'roles.list.forEach(() => entry.formations.push(node.id))', ['group-system', 'group-reconcile']],
  ['a formation with no known system is dropped', 'unplaced.push({ id: node.id, reasons: place.reasons.map((reason) => reason.kind) })', 'void 0', ['group-system', 'group-reconcile']],
  ['an unknown rating counts as no rating', 'const rated = (figure) => (figure.value === null ? null : figure.value > 0)', 'const rated = (figure) => (figure.value === null ? false : figure.value > 0)', ['roles', 'role-totals']],
  ['a rating of 0 is a role', 'const rated = (figure) => (figure.value === null ? null : figure.value > 0)', 'const rated = (figure) => (figure.value === null ? null : figure.value >= 0)', ['roles', 'role-totals']],
  ['the formations with both ratings are not counted', 'totals.both += roles.geo === true && roles.xeno === true ? 1 : 0', 'totals.both += 0', ['role-totals']],
  ['a formation with no role to count is not counted', 'totals.unknown += roles.undetermined ? 1 : 0', 'totals.unknown += 0', ['role-totals']],
]

const runMutant = async ([name, from, to, ids]) => {
  const directory = mutatedCopy(from, to)

  try {
    const mutant = (await loadUtilities([MODULE], { directory, stubs: STUBS }))[MODULE]
    const failed = await failedIds(mutant)

    check(`mutant: ${name}: caught by ${failed.join(', ') || 'nothing'}`, ids.some((id) => failed.includes(id)), `expected one of ${ids.join(', ')}`)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

// ---------- the parts: the constructed race, each save, the control and each mutant run in a process of their own ----------

const coveredSaves = () => new Set(OWNER_SAVES.map((owner) => `${path.resolve(root, owner[0])}|${owner[1]}|${owner[2]}`))

// One part, in this process: `constructed`, `owner:<index>`, `breadth:<index>`, `control` or `mutant:<index>`.
const runPart = async (part) => {
  const [kind, index] = part.split(':')
  const mod = (await loadUtilities([MODULE], { stubs: STUBS }))[MODULE]

  if (part === 'constructed') {
    console.log('Constructed race and loader')

    const results = [...(await builderResults(mod)), ...(await databaseResults(mod))]

    results.forEach((result) => check(result.name, result.ok, result.detail))
  } else if (kind === 'owner') {
    await ownerSave(mod, OWNER_SAVES[Number(index)])
  } else if (kind === 'breadth') {
    await breadthSave(mod, breadthFiles()[Number(index)], coveredSaves())
  } else if (part === 'control') {
    const results = [...(await builderResults(mod)), ...(await databaseResults(mod))]

    check('control: the unmodified utility passes every check the mutations are judged by', results.every((result) => result.ok))
  } else if (kind === 'mutant') {
    await runMutant(MUTANTS[Number(index)])
  } else {
    throw new Error(`No part is named ${part}`)
  }
}

const main = async () => {
  const options = parseArguments(process.argv.slice(2))

  if (options.part !== null) {
    await runPart(options.part)
    endSection(checks, failures, { unsupportedSaves, emptySaves, skippedSaves })
  }

  const breadth = options.breadth ? breadthFiles() : []

  // In the order they print; the longest start first.
  const parts = [
    { part: 'constructed', weight: 10 },
    ...OWNER_SAVES.map((_owner, index) => ({ part: `owner:${index}`, weight: 10 })),
    ...breadth.map((_file, index) => ({ part: `breadth:${index}`, weight: 5 })),
    ...(options.mutations ? [{ part: 'control', weight: 10 }, ...MUTANTS.map((_mutant, index) => ({ part: `mutant:${index}`, weight: 3 }))] : []),
  ]

  const sections = await runSections(__filename, parts.map(({ part, weight }) => ({ args: ['--part', part], weight })))
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
    unsupportedSaves += counts.extra.unsupportedSaves
    emptySaves += counts.extra.emptySaves
    skippedSaves += counts.extra.skippedSaves
  }

  printed()
  console.log('\nNamed saves')
  OWNER_SAVES.forEach(printed)

  if (options.breadth) {
    console.log('\nEvery other save found')
    breadth.forEach(printed)
  }

  if (options.mutations) {
    console.log('\nMutations')
    printed()
    MUTANTS.forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed (${unsupportedSaves} unsupported, ${emptySaves} empty, ${skippedSaves} skipped)`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
