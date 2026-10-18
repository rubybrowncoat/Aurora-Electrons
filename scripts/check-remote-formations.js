/*
  Checks the remote ground formations of the Galaxy Map and the Survey Progress table (src/renderer/utilities/remote-formations.js over the model of utilities/ground-formations.js) against figures worked out by hand and against the saves.

  Run: bun scripts/check-remote-formations.js [--no-mutations]

  The groups, each check a PASS or FAIL line:
  - A constructed race of 12 formations (at a colony, aboard a ship, stored nowhere, at a colony of another race, at a colony the save lacks; one, both or no rating) whose rows, role filters, marks, totals and sentences are worked out by hand.
  - The view preferences and the deep link of the table.
  - The named saves, opened read-only: the rows, the remote formations, the systems of the marks and the totals are compared with SQL written separately here, and with the counts the saves are known to hold.
  - The pages, run on pseudo-instances: the map's mark, role filter, lazy read and panel fact, and the table's rows, link, sort keys and load state.
  - Planted faults in a copy of the utility and of the pages, each of which must make a named check fail.

  Prints `N of N checks passed`; any failed check sets exit code 1. A save that is not there fails its checks: none is skipped.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const { loadPage, instantiate } = require('./lib/page-loader')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const pagesDirectory = path.join(root, 'src', 'renderer', 'pages')
const REMOTE_FILE = path.join(utilitiesDirectory, 'remote-formations.js')
const MAP_FILE = path.join(pagesDirectory, 'map.vue')
const SURVEY_FILE = path.join(pagesDirectory, 'survey-progress.vue')

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`
const real = (specifier) => `import { createRequire } from 'node:module'\nexport default ${requireOf(specifier)}`

const UTILITY_STUBS = {
  vue: 'export default { observable: (value) => value }',
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
}

const FONT_ROLES = "({ family: 'Test, sans-serif', svg: 'Test', map: 'Test, sans-serif', chart: 'Test, sans-serif', scale: 1, size: (px) => px })"

const MAP_STUBS = {
  vue: UTILITY_STUBS.vue,
  cytoscape: 'const cytoscape = () => ({}); cytoscape.use = () => {}; export default cytoscape',
  'cytoscape-cxtmenu': 'export default {}',
  'cytoscape-fcose': 'export default {}',
  'cytoscape-cola': 'export default {}',
  'lodash/groupBy': real('lodash/groupBy'),
  dayjs: real('dayjs'),
  'dayjs/plugin/utc.js': real('dayjs/plugin/utc.js'),
  romanum: real('romanum'),
  electron: 'export const ipcRenderer = { invoke: (...args) => globalThis.__ipc(...args) }',
}

const MAP_MODULES = {
  'utilities/appearance': 'export const activeAppearance = () => globalThis.__appearance\nexport const MAP_MENU = { fillAlpha: 0.88, activeSlot: 2, activeAlpha: 0.9 }',
  'utilities/appearance-font': `export const fontRoles = () => ${FONT_ROLES}\nexport const whenFontsReady = () => Promise.resolve()`,
  'components/charts/theme': `
    export const chartTheme = (a) => ({ surface: a.surfaces.card, ink: a.inks.body, inkMuted: a.inks.muted, border: a.charts.axis, primary: a.focus.primary, categorical: a.charts.categorical })
    export const mapFont = (roles) => ({ family: roles.map, size: roles.size, font: (px, weight = 400) => weight + ' ' + roles.size(px) + 'px ' + roles.map })
    export const markerPoints = () => null
    export const seriesIdentity = () => null
  `,
}

const SURVEY_STUBS = {
  ...UTILITY_STUBS,
  'lodash/groupBy': real('lodash/groupBy'),
  'lodash/partition': real('lodash/partition'),
  dayjs: real('dayjs'),
  'dayjs/plugin/utc.js': real('dayjs/plugin/utc.js'),
  romanum: real('romanum'),
}

const options = { mutations: !process.argv.includes('--no-mutations') }

let checks = 0
let failures = 0

const check = (name, ok, detail = '') => {
  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` (${detail})` : ''}`)
}

const frozen = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(frozen)
    Object.freeze(value)
  }

  return value
}

const sorted = (list) => [...list].sort((a, b) => a - b)
const ids = (rows) => rows.map((row) => row.id)

// A check: `run(ctx)` returns normally to pass and throws (assert) to fail.
const results = []
const add = (id, name, run) => results.push({ id, name, run })

// ---------- the constructed race ----------

const RACE = 7
const GAME = 1

let rowSequence = 0

const formationRow = (FormationID, over = {}) => ({ FormationID, Name: `Formation ${FormationID}`, Abbreviation: `F${FormationID}`, RaceID: RACE, GameID: GAME, OriginalTemplateID: 0, ReplacementTemplateID: 0, PopulationID: 0, ShipID: 0, ParentFormationID: 0, ...over })
const elementRow = (FormationID, ClassID, Units = 1) => ({ RowID: ++rowSequence, ElementID: rowSequence * 10, FormationID, ClassID, SpeciesID: 1, Units })
const classRow = (GroundUnitClassID, ClassName, ComponentA) => ({ GroundUnitClassID, ClassName, Size: 5, ComponentA, ComponentB: 0, ComponentC: 0, ComponentD: 0 })

// Formations 1, 2 and 12 are at the colony Alpha Prime (system 50, named Sol), 6 at an outpost in system 70 the race has no name for, 3, 4, 5, 11 aboard the Hauler in system 9 (Alpha), 7 aboard a ship in system 71 the race has no name for, 8 at a colony of race 8 in system 80 (Beta), 9 at a colony the save lacks, 10 stored nowhere. Roles: 2 geo, 3 xeno, 4 both, 5 geo with the xeno rating unstored, 11 no elements and 12 a class the save lacks (no role to count), the rest other.
const constructedRows = () => {
  rowSequence = 0

  return {
    formations: [
      formationRow(1, { PopulationID: 1 }),
      formationRow(2, { PopulationID: 1 }),
      formationRow(3, { ShipID: 100 }),
      formationRow(4, { ShipID: 100 }),
      formationRow(5, { ShipID: 100 }),
      formationRow(6, { PopulationID: 2 }),
      formationRow(7, { ShipID: 105 }),
      formationRow(8, { PopulationID: 3 }),
      formationRow(9, { PopulationID: 404 }),
      formationRow(10),
      formationRow(11, { ShipID: 100 }),
      formationRow(12, { PopulationID: 1 }),
    ],
    outsideParents: [],
    elements: [
      elementRow(1, 10),
      elementRow(2, 11),
      elementRow(3, 12),
      elementRow(4, 11),
      elementRow(4, 12),
      elementRow(5, 17),
      elementRow(6, 10),
      elementRow(7, 10),
      elementRow(8, 10),
      elementRow(9, 10),
      elementRow(10, 10),
      elementRow(12, 99),
    ],
    classes: [classRow(10, 'Infantry', 0), classRow(11, 'Geo Survey', 26), classRow(12, 'Xeno Survey', 64), classRow(17, 'Half rated', 27)],
    components: [
      { ComponentTypeID: 26, ComponentName: 'Geo', Geosurvey: 0.1, Xenoarchaeology: 0 },
      { ComponentTypeID: 64, ComponentName: 'Xeno', Geosurvey: 0, Xenoarchaeology: 0.5 },
      { ComponentTypeID: 27, ComponentName: 'Half', Geosurvey: 0.2, Xenoarchaeology: null },
    ],
    templates: [],
    templateElements: [],
    ships: [
      { ShipID: 100, ShipName: 'Hauler', FleetID: 500, MothershipID: 0 },
      { ShipID: 105, ShipName: 'Far', FleetID: 501, MothershipID: 0 },
    ],
    fleets: [
      { FleetID: 500, FleetName: 'Convoy', RaceID: RACE, SystemID: 9, OrbitBodyID: 77, SystemName: 'Alpha' },
      { FleetID: 501, FleetName: 'Dark', RaceID: RACE, SystemID: 71, OrbitBodyID: 0, SystemName: null },
    ],
    populations: [
      { PopulationID: 1, PopName: 'Alpha Prime', RaceID: RACE, SystemID: 50, SystemBodyID: 5, SystemName: 'Sol' },
      { PopulationID: 2, PopName: 'Outpost', RaceID: RACE, SystemID: 70, SystemBodyID: 6, SystemName: null },
      { PopulationID: 3, PopName: 'Captured', RaceID: 8, SystemID: 80, SystemBodyID: 7, SystemName: 'Beta' },
    ],
  }
}

const ALL_ROLES = ['geo', 'xeno', 'other', 'unknown']
const REMOTE_TRUE = [3, 4, 5, 7, 8, 10, 11]
const REMOTE_FALSE = [1, 2, 6, 12]
const REMOTE_NULL = [9]

// ---------- the saves ----------

const allRows = (raw, sql) => new Promise((resolve, reject) => {
  raw.all(sql, (error, rows) => (error ? reject(error) : resolve(rows)))
})

// A read-only stand-in for the app's database object: `query(sql)` resolves to [rows], as Sequelize's raw query does.
const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve({ query: async (sql) => [await allRows(raw, sql)], close: () => new Promise((resolve) => raw.close(() => resolve())) })))
})

// What the saves are known to hold: formations, those stationed at no colony of the race, the roles of all and of those, and the systems of the marks (null where no figure is held).
const FIXTURES = [
  { file: 'AuroraDB.db', GameID: 140, RaceID: 784, formations: 3288, remote: 1568, systems: 31, colony: 1720, remoteRoles: { formations: 1568, geo: 9, xeno: 9, other: 1559, both: 9, unknown: 0 } },
  { file: 'artifacts/falryx-sequential-and-rollback/AuroraDB-2930673230.db', GameID: 141, RaceID: 791, formations: 1455, remote: 0, systems: 0, colony: 1455, allRoles: { geo: 25, xeno: 2 } },
  { file: 'saves/AuroraDB_271_skoormit_saved.db', GameID: 138, RaceID: 785, formations: 206, remote: 11, systems: 9, colony: 195, remoteRoles: { formations: 11, geo: 0, xeno: 0, other: 11, both: 0, unknown: 0 }, allRoles: { geo: 2, xeno: 1 } },
]

// The formations of the race that are stationed at no colony of it, those at a colony the save lacks, and the system of each remote one the race has named, in SQL written here and apart from the module's.
const oracle = async (database, GameID, RaceID) => {
  const q = async (sql) => (await database.query(sql))[0]
  const base = `f.GameID = ${GameID} and f.RaceID = ${RaceID}`
  const noColony = (await q(`select f.FormationID as id from FCT_GroundUnitFormation f where ${base} and (f.PopulationID is null or f.PopulationID <= 0)`)).map((row) => row.id)
  const elsewhere = (await q(`select f.FormationID as id from FCT_GroundUnitFormation f join FCT_Population p on p.PopulationID = f.PopulationID where ${base} and f.PopulationID > 0 and p.RaceID != ${RaceID}`)).map((row) => row.id)
  const lacking = (await q(`select f.FormationID as id from FCT_GroundUnitFormation f where ${base} and f.PopulationID > 0 and not exists (select 1 from FCT_Population p where p.PopulationID = f.PopulationID)`)).map((row) => row.id)
  const named = new Set((await q(`select SystemID from FCT_RaceSysSurvey where GameID = ${GameID} and RaceID = ${RaceID} and Name is not null and Name != ''`)).map((row) => row.SystemID))
  const carried = await q(`select f.FormationID as id, coalesce(fl.SystemID, fm.SystemID) as system from FCT_GroundUnitFormation f join FCT_Ship s on s.ShipID = f.ShipID left join FCT_Fleet fl on fl.FleetID = s.FleetID left join FCT_Ship ms on ms.ShipID = s.MothershipID left join FCT_Fleet fm on fm.FleetID = ms.FleetID where ${base} and (f.PopulationID is null or f.PopulationID <= 0)`)
  const elsewhereSystems = await q(`select f.FormationID as id, p.SystemID as system from FCT_GroundUnitFormation f join FCT_Population p on p.PopulationID = f.PopulationID where ${base} and f.PopulationID > 0 and p.RaceID != ${RaceID}`)
  const systemOf = new Map([...carried, ...elsewhereSystems].map((row) => [row.id, row.system]))
  const remote = new Set([...noColony, ...elsewhere])
  const bySystem = new Map()

  remote.forEach((id) => {
    const system = systemOf.get(id)

    if (Number.isInteger(system) && named.has(system)) {
      bySystem.set(system, [...(bySystem.get(system) || []), id])
    }
  })

  const placed = new Set([...bySystem.values()].flat())

  return { remote, unknown: new Set(lacking), named, bySystem, unplaced: [...remote].filter((id) => !placed.has(id)) }
}

// ---------- the checks, over a context { mod (remote-formations), links, models, saves, map, survey } ----------

add('rows-once', 'a row per formation, each once, in the order of the model', ({ mod, models }) => {
  const model = models.constructed
  const rows = mod.formationRows(model)

  assert.deepEqual(ids(rows), model.formations.map((node) => node.id))
  assert.equal(new Set(ids(rows)).size, 12)
})

add('rows-place', 'a row says whether it is remote (true, false or not known), what holds it and why it has no system', ({ mod, models }) => {
  const rows = new Map(mod.formationRows(models.constructed).map((row) => [row.id, row]))

  assert.deepEqual(sorted([...rows.values()].filter((row) => row.remote === true).map((row) => row.id)), REMOTE_TRUE)
  assert.deepEqual(sorted([...rows.values()].filter((row) => row.remote === false).map((row) => row.id)), REMOTE_FALSE)
  assert.deepEqual(sorted([...rows.values()].filter((row) => row.remote === null).map((row) => row.id)), REMOTE_NULL)
  assert.equal(rows.get(3).heldBy, 'Ship Hauler')
  assert.equal(rows.get(1).heldBy, 'Colony Alpha Prime')
  assert.equal(rows.get(10).heldBy, 'Nothing stored')
  assert.deepEqual(rows.get(3).system, { id: 9, name: 'Alpha' })
  assert.equal(rows.get(3).systemName, 'Alpha')
  assert.deepEqual([6, 7, 9, 10].map((id) => rows.get(id).system), [null, null, null, null])
  assert.deepEqual([6, 7, 9, 10].map((id) => rows.get(id).reasons.map((reason) => reason.kind)), [['system-not-surveyed'], ['system-not-surveyed'], ['population-missing'], ['unlocated']])
  assert.ok([1, 2, 3, 4, 5, 8, 11, 12].every((id) => rows.get(id).system !== null && rows.get(id).reasons.length === 0))
})

const rolesOf = (mod, rows, selected, remoteOnly) => ids(mod.selectRows(rows, { roles: selected, remoteOnly })).sort((a, b) => a - b)

add('select-roles', 'a role filter keeps the formations in a selected role, one with two ratings in both and once when both are selected', ({ mod, models }) => {
  const rows = mod.formationRows(models.constructed)

  assert.deepEqual(rolesOf(mod, rows, ['geo'], false), [2, 4, 5])
  assert.deepEqual(rolesOf(mod, rows, ['xeno'], false), [3, 4])
  assert.deepEqual(rolesOf(mod, rows, ['geo', 'xeno'], false), [2, 3, 4, 5])
  assert.deepEqual(rolesOf(mod, rows, ['other'], false), [1, 6, 7, 8, 9, 10])
  assert.deepEqual(rolesOf(mod, rows, ['unknown'], false), [11, 12])
  assert.deepEqual(rolesOf(mod, rows, ALL_ROLES, false), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.deepEqual(rolesOf(mod, rows, [], false), [])
})

add('select-remote', 'with the remote switch on a formation at a colony of the race is left out and one whose colony the save lacks stays', ({ mod, models }) => {
  const rows = mod.formationRows(models.constructed)

  assert.deepEqual(rolesOf(mod, rows, ALL_ROLES, true), [3, 4, 5, 7, 8, 9, 10, 11])
  assert.deepEqual(rolesOf(mod, rows, ['geo'], true), [4, 5])
  assert.deepEqual(rolesOf(mod, rows, ['other'], true), [7, 8, 9, 10])
  assert.deepEqual(rolesOf(mod, rows, ['unknown'], true), [11])
  assert.deepEqual(rolesOf(mod, rows, ['geo', 'xeno'], true), [3, 4, 5])
})

add('marks', 'the marks are the systems the race has named that hold remote formations of the selected roles, each formation once, the rest unplaced with their reasons', ({ mod, models }) => {
  const all = mod.remoteSystems(models.constructed, ALL_ROLES)

  assert.deepEqual(Object.keys(all.systems).sort(), ['80', '9'])
  assert.deepEqual(all.systems['9'].formations, [3, 4, 5, 11])
  assert.deepEqual(all.systems['9'].roles, { geo: 2, xeno: 2, other: 0, unknown: 1 })
  assert.deepEqual(all.systems['80'].formations, [8])
  assert.deepEqual(all.unplaced, [{ id: 7, reasons: ['system-not-surveyed'] }, { id: 10, reasons: ['unlocated'] }])
  assert.equal(all.formations, 7)
  assert.equal(Object.values(all.systems).reduce((sum, entry) => sum + entry.formations.length, 0) + all.unplaced.length, REMOTE_TRUE.length)

  const geo = mod.remoteSystems(models.constructed, ['geo'])

  assert.deepEqual(Object.keys(geo.systems), ['9'])
  assert.deepEqual(geo.systems['9'].formations, [4, 5])
  assert.deepEqual(geo.unplaced, [])
  assert.equal(mod.remoteSystems(models.constructed, []).formations, 0)
  assert.deepEqual(Object.keys(mod.remoteSystems(models.constructed, ['unknown']).systems), ['9'])
})

add('marks-honest', 'a mark carries no coordinate and no system the race has not named, and a formation whose colony is missing has none', ({ mod, models }) => {
  const all = mod.remoteSystems(models.constructed, ALL_ROLES)

  assert.ok(Object.values(all.systems).every((entry) => JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(['formations', 'id', 'name', 'roles', 'sets'])))
  assert.ok(!Object.values(all.systems).some((entry) => [6, 7, 9, 10].some((id) => entry.formations.includes(id))))
  assert.ok(![1, 2, 6, 12].some((id) => Object.values(all.systems).some((entry) => entry.formations.includes(id))))
  assert.ok(!all.unplaced.some((entry) => entry.id === 9))
})

add('totals', 'the totals of the table are those of the formations in scope and the roles add up to them, a formation with both ratings once', ({ mod, models }) => {
  const remote = mod.rowTotals(models.constructed, { remoteOnly: true })

  assert.deepEqual(remote, { formations: 8, geo: 2, xeno: 2, other: 4, both: 1, unknown: 1, placed: 5, unplaced: 3, remote: 7, remoteUnknown: 1, atColonies: 4 })
  assert.equal(remote.geo + remote.xeno - remote.both + remote.other + remote.unknown, remote.formations)

  const everything = mod.rowTotals(models.constructed, { remoteOnly: false })

  assert.deepEqual(everything, { formations: 12, geo: 3, xeno: 2, other: 6, both: 1, unknown: 2, placed: 8, unplaced: 4, remote: 7, remoteUnknown: 1, atColonies: 4 })
  assert.equal(everything.geo + everything.xeno - everything.both + everything.other + everything.unknown, everything.formations)
  assert.equal(everything.placed + everything.unplaced, everything.formations)
  assert.equal(everything.remote + everything.remoteUnknown + everything.atColonies, everything.formations)
})

add('totals-rows', 'the rows of each role and the totals of the chips are the same formations', ({ mod, models }) => {
  const rows = mod.formationRows(models.constructed)

  ;[true, false].forEach((remoteOnly) => {
    const totals = mod.rowTotals(models.constructed, { remoteOnly })

    assert.equal(mod.selectRows(rows, { roles: ALL_ROLES, remoteOnly }).length, totals.formations)
    ;['geo', 'xeno', 'other', 'unknown'].forEach((role) => {
      assert.equal(mod.selectRows(rows, { roles: [role], remoteOnly }).length, totals[role], `${role}, remote only ${remoteOnly}`)
    })
  })
})

add('system-text', 'the sentence of a system names the roles present, one role alone by its own count', ({ mod, models }) => {
  const count = String
  const all = mod.remoteSystems(models.constructed, ALL_ROLES)
  const geo = mod.remoteSystems(models.constructed, ['geo'])

  assert.equal(mod.systemText(all.systems['9'], count), '4 (2 geological, 2 xenoarchaeology, 1 role not known)')
  assert.equal(mod.systemText(all.systems['80'], count), '1 other')
  assert.equal(mod.systemText(geo.systems['9'], count), '2 (2 geological, 1 xenoarchaeology)')
})

add('views', 'the role filter is a persisted view of the race with every role on, a stored value keeps the roles still offered, and the remote switch is on', ({ mod }) => {
  assert.deepEqual([mod.rolesView.key, mod.rolesView.scope], ['groundRoles', 'race'])
  assert.deepEqual([...mod.rolesView.default], ALL_ROLES)
  assert.deepEqual(mod.rolesView.normalise(['xeno', 'bogus', 'geo']), ['geo', 'xeno'])
  assert.deepEqual(mod.rolesView.normalise([]), [])
  assert.equal(mod.rolesView.normalise('geo'), undefined)
  assert.equal(mod.rolesView.normalise(undefined), undefined)
  assert.deepEqual([mod.remoteOnlyView.key, mod.remoteOnlyView.scope, mod.remoteOnlyView.default], ['groundRemoteOnly', 'race', true])
  assert.deepEqual(mod.ROLE_OPTIONS.map((option) => option.value), ALL_ROLES)
  assert.deepEqual(mod.ROLE_OPTIONS.map((option) => option.text), ['Geological', 'Xenoarchaeology', 'Other', 'Role not known'])
})

add('link', 'the deep link opens the table on one system', ({ links }) => {
  assert.deepEqual(links.formations(21740), { path: '/survey-progress', query: { formations: '21740' } })
  assert.deepEqual(links.formations(null), { path: '/survey-progress', query: {} })
})

FIXTURES.forEach((fixture, index) => {
  const label = `${fixture.file} (game ${fixture.GameID}, race ${fixture.RaceID})`
  const state = (ctx) => ctx.saves[index]

  add(`save-${index}-rows`, `${label}: a row per formation of the race, each once, and the formations are those known to be held`, (ctx) => {
    const { model } = state(ctx)
    const rows = ctx.mod.formationRows(model)

    assert.equal(rows.length, fixture.formations)
    assert.equal(new Set(ids(rows)).size, fixture.formations)
    assert.deepEqual(sorted(ids(rows)), sorted(state(ctx).truth.all))
  })

  add(`save-${index}-remote`, `${label}: the formations marked remote are those the save stores at no colony of the race or at a colony of another, and those whose colony is missing are not known`, (ctx) => {
    const { model, truth } = state(ctx)
    const rows = ctx.mod.formationRows(model)

    assert.deepEqual(sorted(rows.filter((row) => row.remote === true).map((row) => row.id)), sorted([...truth.remote]))
    assert.deepEqual(sorted(rows.filter((row) => row.remote === null).map((row) => row.id)), sorted([...truth.unknown]))
    assert.equal(truth.remote.size, fixture.remote)
    assert.equal(rows.filter((row) => row.remote === false).length, fixture.colony)
    assert.equal(ctx.mod.selectRows(rows, { roles: ALL_ROLES, remoteOnly: true }).length, fixture.remote + truth.unknown.size)
  })

  add(`save-${index}-marks`, `${label}: the systems of the marks are those the race has named, each remote formation is in the system its fleet is in, and the rest are unplaced`, (ctx) => {
    const { model, truth } = state(ctx)
    const marks = ctx.mod.remoteSystems(model, ALL_ROLES)
    const entries = Object.values(marks.systems)

    assert.equal(entries.length, fixture.systems)
    assert.deepEqual(sorted(entries.map((entry) => entry.id)), sorted([...truth.bySystem.keys()]))
    assert.ok(entries.every((entry) => truth.named.has(entry.id) && entry.name !== ''))
    entries.forEach((entry) => assert.deepEqual(sorted(entry.formations), sorted(truth.bySystem.get(entry.id)), `system ${entry.id}`))
    assert.equal(entries.reduce((sum, entry) => sum + entry.formations.length, 0) + marks.unplaced.length, fixture.remote)
    assert.deepEqual(sorted(marks.unplaced.map((entry) => entry.id)), sorted(truth.unplaced))
    assert.ok(marks.unplaced.every((entry) => entry.reasons.length > 0))
  })

  add(`save-${index}-roles`, `${label}: the role totals add up, a formation with both ratings once, and the filters of the rows agree with them`, (ctx) => {
    const { model } = state(ctx)
    const rows = ctx.mod.formationRows(model)

    ;[true, false].forEach((remoteOnly) => {
      const totals = ctx.mod.rowTotals(model, { remoteOnly })

      assert.equal(totals.geo + totals.xeno - totals.both + totals.other + totals.unknown, totals.formations)
      assert.equal(ctx.mod.selectRows(rows, { roles: ALL_ROLES, remoteOnly }).length, totals.formations)
      assert.equal(ctx.mod.selectRows(rows, { roles: ['geo', 'xeno'], remoteOnly }).length, totals.geo + totals.xeno - totals.both)
      ;['geo', 'xeno', 'other', 'unknown'].forEach((role) => assert.equal(ctx.mod.selectRows(rows, { roles: [role], remoteOnly }).length, totals[role], `${role}, remote only ${remoteOnly}`))
    })
  })

  if (fixture.remoteRoles) {
    add(`save-${index}-remote-roles`, `${label}: the remote formations are ${JSON.stringify(fixture.remoteRoles)} by role`, (ctx) => {
      const totals = ctx.mod.rowTotals(state(ctx).model, { remoteOnly: true })
      const { formations, geo, xeno, other, both, unknown } = totals

      assert.deepEqual({ formations: formations - state(ctx).truth.unknown.size, geo, xeno, other, both, unknown }, fixture.remoteRoles)
    })
  }

  if (fixture.allRoles) {
    add(`save-${index}-all-roles`, `${label}: the formations of the race with a geological or xenoarchaeology rating are ${JSON.stringify(fixture.allRoles)}`, (ctx) => {
      const totals = ctx.mod.rowTotals(state(ctx).model, { remoteOnly: false })

      assert.deepEqual({ geo: totals.geo, xeno: totals.xeno }, fixture.allRoles)
    })
  }
})

// The pages, loaded from their scripts and run on a pseudo instance (scripts/lib/page-loader.js): the map draws its mark from the systems that remoteSystems gives, and the table lists the rows the views select.
const pageResults = []
const pageAdd = (id, name, run) => pageResults.push({ id, name, run })

const NO_FEATURES = { ruins: [], constructs: [], rifts: 0, wrecks: 0, protection: 0, military: 0, ships: 0, shipyards: 0, waypoints: 0, contacts: [] }
const MAP_SYSTEMS = [[9, 'Alpha'], [80, 'Beta'], [50, 'Sol'], [7, 'Dark']].map(([SystemID, Name], index) => ({ SystemID, Name, Xcor: index * 60, Ycor: 0, Bodies: 4, SurveyedBodies: 1, Planets: 3, Comets: 0, GroundSurveys: 0, Colonies: 0, Population: 0, PopulationReported: 1, Capital: 0, DangerRating: 0, NoAutoRoute: 0, Stars: 1, SpectralClass: 'G', SizeText: 'V', DiscoveredTime: 1000 * SystemID, X: index, Y: 0, Z: 0 }))

const mapView = (ctx, data = {}) => {
  globalThis.__appearance = ctx.appearance

  return instantiate(ctx.pages.map, { $store: { getters: { StartYear: 2050, GameTime: 12345, racePrefix: null, config: { get: (_key, fallback) => fallback } }, state: { history: { revision: 0 } } }, GameID: GAME, RaceID: RACE, data: { loadErrors: {}, systems: MAP_SYSTEMS, jumpPoints: [], sectors: [], aliens: [], features: Object.fromEntries(MAP_SYSTEMS.map((system) => [String(system.SystemID), NO_FEATURES])), habitability: null, formulaVersion: null, hierarchy: 'restrained', layer: 'geological', borders: 'none', activateSnackbar: () => {}, ...data } })
}

const marked = (vm) => vm.systemRows.filter((row) => vm.glyphsOf(row).some((glyph) => glyph.name === 'remote')).map((row) => row.SystemID).sort((a, b) => a - b)

pageAdd('page-map-mark', 'the map marks the systems that hold remote formations of the selected roles, once each, only while the mark is on, and a marked system keeps its name at full strength', (ctx) => {
  const on = mapView(ctx, { marks: ['remote'], groundFormations: ctx.models.supportedConstructed, remoteRoles: ALL_ROLES })

  assert.deepEqual(marked(on), [9, 80])
  assert.deepEqual(Object.keys(on.remoteBySystem).sort(), ['80', '9'])
  const ink = (id) => on.markerData(on.systemRows.find((row) => row.SystemID === id)).labelInk

  assert.ok(ink(9) === ink(80) && ink(9) !== ink(50) && ink(50) === ink(7))
  assert.ok(on.marksLegend.some((item) => item.kind === 'glyph' && /^Systems with remote ground formations \(2\)$/.test(item.label)))
  assert.ok(on.marksLegend.some((item) => item.kind === 'note' && item.label.startsWith(ctx.mod.REMOTE_LEGEND)))
  assert.deepEqual(marked(mapView(ctx, { marks: [], groundFormations: ctx.models.supportedConstructed, remoteRoles: ALL_ROLES })), [])
  assert.deepEqual(marked(mapView(ctx, { marks: ['remote'], groundFormations: { supported: false, missing: ['FCT_GroundUnitFormation'] }, remoteRoles: ALL_ROLES })), [])
  assert.deepEqual(marked(mapView(ctx, { marks: ['remote'], groundFormations: null, remoteRoles: ALL_ROLES })), [])
})

pageAdd('page-map-roles', 'the role filter of the map narrows the marked systems to those with formations of the selected roles', (ctx) => {
  const at = (remoteRoles) => marked(mapView(ctx, { marks: ['remote'], groundFormations: ctx.models.supportedConstructed, remoteRoles }))

  assert.deepEqual(at(['geo']), [9])
  assert.deepEqual(at(['xeno']), [9])
  assert.deepEqual(at(['other']), [80])
  assert.deepEqual(at(['unknown']), [9])
  assert.deepEqual(at([]), [])
})

pageAdd('page-map-read', 'the map reads the ground formations only while the mark is on', async (ctx) => {
  const asked = []
  const database = { query: async (sql) => { asked.push(sql); throw new Error('asked') } }
  const off = mapView(ctx, { marks: [] })

  off.database = database
  assert.equal(await off.runAsync('groundFormations'), null)
  assert.equal(asked.length, 0)

  const on = mapView(ctx, { marks: ['remote'] })

  on.database = database
  await assert.rejects(() => on.runAsync('groundFormations'))
  assert.ok(asked.length > 0)
})

pageAdd('page-map-panel', 'the panel of a marked system states its remote formations and opens them in the table, and an unmarked one says nothing', (ctx) => {
  const pushed = []
  const panel = (id, remoteRoles = ALL_ROLES) => {
    const vm = mapView(ctx, { marks: ['remote'], groundFormations: ctx.models.supportedConstructed, remoteRoles, hops: {}, groupOf: {}, $router: { push: (location) => pushed.push(location) } })

    vm.panelSystem = vm.rowById[String(id)]

    return vm.panelFacts.find((fact) => fact.label === 'Remote ground formations')
  }
  const fact = panel(9)

  assert.equal(fact.value, '4 (2 geological, 2 xenoarchaeology, 1 role not known)')
  fact.action()
  assert.deepEqual(pushed, [ctx.links.formations(9)])
  assert.equal(panel(50), undefined)
  assert.equal(panel(9, ['other']), undefined)
})

const surveyView = (ctx, data = {}) => instantiate(ctx.pages.survey, { $store: { getters: {}, state: {} }, data: { loadErrors: {}, formations: ctx.models.supportedConstructed, remoteRoles: ALL_ROLES, remoteOnly: false, formationSystem: null, ...data } })

pageAdd('page-survey-table', 'the table lists the rows the roles, the remote switch and a system select, and its totals are those of the rows', (ctx) => {
  const listed = (data) => ids(surveyView(ctx, data).formationList).sort((a, b) => a - b)

  assert.deepEqual(listed({}), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.deepEqual(listed({ remoteOnly: true }), [3, 4, 5, 7, 8, 9, 10, 11])
  assert.deepEqual(listed({ remoteRoles: ['geo'], remoteOnly: true }), [4, 5])
  assert.deepEqual(listed({ remoteRoles: [] }), [])
  assert.deepEqual(listed({ formationSystem: 9 }), [3, 4, 5, 11])
  assert.deepEqual(listed({ formationSystem: 9, remoteRoles: ['xeno'] }), [3, 4])
  assert.deepEqual(surveyView(ctx, { remoteOnly: true }).formationTotals, ctx.mod.rowTotals(ctx.models.supportedConstructed, { remoteOnly: true }))
  assert.deepEqual(surveyView(ctx, { formations: { supported: false, missing: ['FCT_GroundUnitFormation'] } }).formationList, [])
})

pageAdd('page-survey-open', 'a row opens its system on the map, and one with no known system opens nothing', (ctx) => {
  const pushed = []
  const vm = surveyView(ctx, { $router: { push: (location) => pushed.push(location) } })
  const rows = new Map(vm.formationAll.map((row) => [row.id, row]))

  vm.openFormation(rows.get(3))
  vm.openFormation(rows.get(10))
  assert.deepEqual(pushed, [ctx.links.map(9)])
})

pageAdd('page-survey-reveal', 'a link to a system\'s formations scrolls to the panel once, when the page draws it, even if the formations arrive before another input', (ctx) => {
  const keys = Object.keys(ctx.pages.survey.asyncComputed)
  const loaded = Object.fromEntries(keys.map((key) => [key, null]))
  const scrolled = []
  const vm = surveyView(ctx, { loadErrors: { ...loaded, systems: undefined }, formationsPending: false, $refs: {}, $vuetify: { goTo: (element) => scrolled.push(element) } })

  // What Vue does on a change of a watched value: the page's own handler runs with the instance.
  const changed = (name) => ctx.pages.survey.watch[name].call(vm)

  vm.applyLink({ formations: '9' })
  assert.equal(vm.formationSystem, 9)
  assert.ok(vm.formationAll.length > 0 && vm.ready === false)
  changed('formationAll')
  assert.deepEqual(scrolled, [])
  assert.equal(vm.formationsPending, true)

  vm.loadErrors = loaded
  assert.equal(vm.ready, true)

  const panel = { $el: { panel: true } }

  vm.$refs.formationsPanel = panel
  changed('ready')
  changed('ready')
  changed('formationAll')
  assert.deepEqual(scrolled, [panel.$el])
  assert.equal(vm.formationsPending, false)
})

pageAdd('page-survey-sort', 'every column of the table sorts by a value its rows carry, and the Where and Role columns tell the rows apart', (ctx) => {
  const vm = surveyView(ctx)
  const keys = vm.formationHeaders.filter((header) => header.sortable !== false).map((header) => header.value)

  assert.deepEqual(keys, ['name', 'systemName', 'heldBy', 'where', 'roleLabel', 'geo', 'xeno'])
  vm.formationAll.forEach((row) => keys.forEach((key) => assert.ok(row[key] !== undefined, `row ${row.id} has no ${key}`)))
  assert.deepEqual([...new Set(vm.formationAll.map((row) => row.where))].sort(), ['At a colony', 'Not known', 'Remote'])
  assert.deepEqual([...new Set(vm.formationAll.map((row) => row.roleLabel))].sort(), ['Geological', 'Geological · Xenoarchaeology', 'Not known', 'Other', 'Xenoarchaeology'])
})

pageAdd('page-survey-ready', 'the page holds its content back while any read is loading or has failed, the naval admins and the formations among them', (ctx) => {
  const keys = Object.keys(ctx.pages.survey.asyncComputed)
  const everyKey = (value) => Object.fromEntries(keys.map((key) => [key, value]))
  const vm = (loadErrors) => surveyView(ctx, { loadErrors, $store: undefined })

  assert.ok(keys.includes('navalAdmins') && keys.includes('formations'))
  assert.equal(vm(everyKey(null)).ready, true)

  keys.forEach((key) => {
    assert.equal(vm({ ...everyKey(null), [key]: undefined }).ready, false, `${key} pending`)
    assert.deepEqual(vm({ ...everyKey(null), [key]: 'boom' }).failedInputs, [key], `${key} failed`)
    assert.equal(vm({ ...everyKey(null), [key]: 'boom' }).ready, false, `${key} failed`)
  })
})

// ---------- running ----------

const run = async (list, ctx) => {
  const out = []

  for (const item of list) {
    try {
      await item.run(ctx)
      out.push({ id: item.id, name: item.name, ok: true, detail: '' })
    } catch (error) {
      out.push({ id: item.id, name: item.name, ok: false, detail: String(error.message).split('\n')[0] })
    }
  }

  return out
}

const MUTANTS = [
  ['the role filter is ignored', 'inRoles(row.roles, roles) && (!remoteOnly', '(!remoteOnly', REMOTE_FILE, ['select-roles', 'totals-rows']],
  ['only the first role of a formation counts', 'roles.list.some((role) => selected.includes(role))', 'selected.includes(roles.list[0])', REMOTE_FILE, ['select-roles', 'marks', 'totals-rows']],
  ['a formation with no role to count is never shown', 'roles.undetermined ? selected.includes(\'unknown\') : roles.list.some', 'roles.list.some', REMOTE_FILE, ['select-roles', 'totals-rows']],
  ['the marks hold the formations not known to be at a colony', 'place.remote === true && inRoles(roles, selected)', 'place.remote !== false && inRoles(roles, selected)', REMOTE_FILE, ['marks', 'marks-honest']],
  ['the remote switch keeps only what is known to be remote', 'row.remote !== false))', 'row.remote === true))', REMOTE_FILE, ['select-remote', 'totals-rows']],
  ['the totals of the table count the formations at colonies', 'const inScope = (_node, place) => !remoteOnly || place.remote !== false', 'const inScope = () => true', REMOTE_FILE, ['totals', 'totals-rows']],
  ['a stored role that is no longer offered is kept', 'ROLE_KEYS.filter((role) => stored.includes(role))', 'stored', REMOTE_FILE, ['views']],
  ['a formation is listed twice', 'model.formations.map((node) => {', 'model.formations.flatMap((node) => [node, node]).map((node) => {', REMOTE_FILE, ['rows-once', 'select-roles']],
  ['the remote switch starts off', 'default: true })', 'default: false })', REMOTE_FILE, ['views']],
  ['the map never draws the mark', 'return this.remoteModel ? remoteSystems(this.remoteModel, this.remoteRoles) : null', 'return null', MAP_FILE, ['page-map-mark', 'page-map-roles', 'page-map-panel']],
  ['the map reads the formations whether or not the mark is on', "|| !this.marksSet.has('remote')) {\n          return null", ') {\n          return null', MAP_FILE, ['page-map-read']],
  ['the table shows every row whatever the filters say', 'selectRows(this.formationAll, { roles: this.remoteRoles, remoteOnly: this.remoteOnly })', 'this.formationAll', SURVEY_FILE, ['page-survey-table']],
  ['the table sorts the Where column by a key its rows lack', "{ text: 'Where', value: 'where' }", "{ text: 'Where', value: 'remoteSort' }", SURVEY_FILE, ['page-survey-sort']],
  ['the page forgets to wait for the naval admins', "  navalAdmins: 'naval admin commands',\n", '', SURVEY_FILE, ['page-survey-ready']],
  ['a link is cleared before the page draws the panel', 'if (this.formationsPending && this.formationAll.length && this.ready) {', 'if (this.formationsPending && this.formationAll.length) {\n        this.formationsPending = false', SURVEY_FILE, ['page-survey-reveal']],
  ['the reveal is not retried when the page becomes ready', '    ready() {\n      this.revealFormations()\n    },\n', '', SURVEY_FILE, ['page-survey-reveal']],
  ['a row opens the map on no system', 'this.$router.push(linkTo.map(item.system.id))', 'this.$router.push(linkTo.map(item.id))', SURVEY_FILE, ['page-survey-open']],
]

const main = async () => {
  const sources = { remote: fs.readFileSync(REMOTE_FILE, 'utf8'), map: fs.readFileSync(MAP_FILE, 'utf8'), survey: fs.readFileSync(SURVEY_FILE, 'utf8') }
  const appearance = (await loadUtilities(['appearance'], { stubs: UTILITY_STUBS })).appearance.resolveAppearance('light')

  // The two pages, each with the texts it is given: a fault planted in the utility reaches them through their import of it.
  const pagesOf = async (given) => {
    const text = { 'utilities/remote-formations': given.remote }

    return {
      map: await loadPage('pages/map', { sources: { ...text, 'pages/map': given.map }, stubs: MAP_STUBS, modules: MAP_MODULES }),
      survey: await loadPage('pages/survey-progress', { sources: { ...text, 'pages/survey-progress': given.survey }, stubs: SURVEY_STUBS, modules: { 'mixins/load-state': null } }),
    }
  }
  const loaded = await loadUtilities(['remote-formations', 'ground-formations', 'deep-links'], { stubs: { dayjs: real('dayjs'), 'dayjs/plugin/utc.js': real('dayjs/plugin/utc.js'), romanum: 'export default { toNumeral: String }' } })
  const ground = loaded['ground-formations']
  const models = { constructed: ground.buildGroundFormations(frozen(constructedRows()), { GameID: GAME, RaceID: RACE }) }
  models.supportedConstructed = { supported: true, ...models.constructed }
  const saves = []

  for (const fixture of FIXTURES) {
    const database = await openSave(fixture.file)

    if (!database) {
      saves.push(null)
      continue
    }

    const model = await ground.loadGroundFormations(database, { GameID: fixture.GameID, RaceID: fixture.RaceID })
    const truth = await oracle(database, fixture.GameID, fixture.RaceID)
    const all = (await database.query(`select FormationID as id from FCT_GroundUnitFormation where GameID = ${fixture.GameID} and RaceID = ${fixture.RaceID}`))[0].map((row) => row.id)

    saves.push({ model, truth: { ...truth, all } })
    await database.close()
  }

  const context = (mod, pages) => ({ mod, pages, appearance, links: loaded['deep-links'].linkTo, models, saves })

  console.log('Constructed race, preferences and saves')

  const own = [...results, ...pageResults]
  const base = await run(own, context(loaded['remote-formations'], await pagesOf(sources)))

  base.forEach((result) => check(result.name, result.ok, result.detail))

  const missing = FIXTURES.map((fixture, index) => (saves[index] ? null : fixture.file)).filter(Boolean)

  check('every named save is there', missing.length === 0, missing.join(', '))
  check('every save check ran', base.filter((result) => result.id.startsWith('save-')).length === FIXTURES.reduce((sum, fixture) => sum + 4 + (fixture.remoteRoles ? 1 : 0) + (fixture.allRoles ? 1 : 0), 0))

  if (options.mutations) {
    console.log('\nPlanted faults')

    for (const [name, from, to, file, expected] of MUTANTS) {
      const original = file === REMOTE_FILE ? sources.remote : file === MAP_FILE ? sources.map : sources.survey
      const text = patched(file, original, from, to)
      const given = { remote: file === REMOTE_FILE ? text : sources.remote, map: file === MAP_FILE ? text : sources.map, survey: file === SURVEY_FILE ? text : sources.survey }
      const mod = file === REMOTE_FILE ? (await loadUtilities(['remote-formations'], { sources: { 'remote-formations': text } }))['remote-formations'] : loaded['remote-formations']
      const failed = (await run(own, context(mod, await pagesOf(given)))).filter((result) => !result.ok).map((result) => result.id)

      check(`planted: ${name}: caught by ${failed.join(', ') || 'nothing'}`, expected.some((id) => failed.includes(id)), `expected one of ${expected.join(', ')}`)
    }
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
