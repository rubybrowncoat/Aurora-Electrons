/* eslint-disable no-template-curly-in-string */
/*
  Checks the avoid settings on the routes Transport and Hauling plan (src/renderer/utilities/safe-routes.js, with the entry predicate of route-plan.js and the search of jump-graph.js, the Hauling plan of haul-plan.js and the two pages) on a worked fixture and, read-only, on the jump points, systems and colonies the saves hold.

  bun scripts/check-safe-routes.js [--no-mutations] [--save <save.db> <GameID> <RaceID>]...

  Fixture: a graph of systems around one origin. A short way to the far system through a dangerous one and a longer way round it; a destination behind an alien-held system that a second alien-held system also reaches, with a barred dead end beside the origin; a destination behind a system whose holder is not known, one behind a system the player flagged, one behind a system held by a race with a trade treaty, one behind a dangerous system the race's own ships protect; jump points charted but not explored, one of them in front of a barred system and one of them a shortcut; systems the race holds no row for; an origin that is itself dangerous. Statements: with nothing avoided a run is the Route Finder's own, a detour has the allowed path's distance and names what it avoids and which setting is responsible, a cut-off run names the observed systems that cut it off and never a dead end or a system behind an unexplored jump point, an unknown control, a player flag and an observed danger are told apart, the origin is never avoided and the destination always is, clearing the settings restores the baseline run and plan, and the Transport and Hauling pages take distance, time, fuel and yearly capacity from the one allowed path, plan nothing while the systems they need are not read, persist the settings per race and say so in the section's own terms.

  Saves: the loader against the saves' own rows, the settings off against the search, and every allowed route against the systems it enters. A save that is not there is reported as skipped and never counted as passed.

  Mutations: each planted fault must fail the checks it names, and every one names a fixture check so that it is caught with no save there; benign edits must leave every fixture check green. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const renderer = path.join(root, 'src', 'renderer')
const DEFAULT_SAVES = [
  { label: 'modded', file: 'AuroraDB.db', game: 140, race: 784 },
  { label: 'stock', file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
]
// The parts run as children of the one that was started, so the saves given on its command line reach them through the environment.
const SAVES = process.env.SAFE_ROUTES_SAVES ? JSON.parse(process.env.SAFE_ROUTES_SAVES) : DEFAULT_SAVES
const FILES = {
  'safe-routes': 'utilities/safe-routes.js',
  'haul-plan': 'utilities/haul-plan.js',
  'route-plan': 'utilities/route-plan.js',
  'avoid-routes': 'mixins/avoid-routes.js',
  information: 'pages/information.vue',
  hauling: 'pages/hauling.vue',
  routes: 'pages/routes.vue',
  options: 'components/page/AvoidOptions.vue',
}
const UTILITIES = ['safe-routes', 'haul-plan', 'route-plan']
const NAMES = ['safe-routes', 'jump-graph', 'route-plan', 'provenance', 'transport', 'haul-plan', 'hauling']
const ORIGINALS = Object.fromEntries(Object.entries(FILES).map(([key, file]) => [key, fs.readFileSync(path.join(renderer, file), 'utf8')]))
const LABELS_STUB = 'export default (labels) => ({ computed: { inputLabels: () => labels } })'
const RECORDER = 'export const oneOf = (values) => (value) => values.includes(value); export const tableView = (key, defaults) => ({ key, default: defaults, table: true }); export default (fields) => { globalThis.__persistedFields = fields; return { data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) } }'
const STORE = { getters: { 'capabilities/result': {}, 'capabilities/report': () => null, 'capabilities/blockedBonuses': new Set(), CivilianShippingLinesActive: false }, state: { RaceNPR: false }, dispatch: async () => {} }

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  if (result && result.skipped) {
    console.log(`SKIP  ${name}  [${result.skipped}]`)

    return
  }

  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const skip = (reason) => ({ skipped: reason })
const near = (actual, expected, epsilon = 1e-9) => assert.ok(typeof actual === 'number' && Math.abs(actual - expected) <= epsilon * Math.max(1, Math.abs(expected)), `${actual} is not ${expected}`)

// ---------- the fixture ----------

const M = 1e6
const VERSION = '2.7.1'
const TECH = 1.5
const jp = (id, system, link, x, y, explored = 1) => ({ WarpPointID: id, SystemID: system, WPLink: link, Distance: 0, Xcor: x * M, Ycor: y * M, JumpGateStrength: 0, Explored: explored, MilitaryRestricted: 0, IgnoreForDistance: 0 })

// [system, system, jump point at the first (in million km), jump point at the second, explored at the first]. A jump point's id is its system times 100 plus the other's.
const LINKS = [
  [1, 2, [1, 0], [0, 0]],
  [2, 6, [3, 0], [0, 0]],
  [1, 4, [0, 5], [0, 0]],
  [4, 5, [5, 0], [0, 0]],
  [5, 6, [5, 5], [0, 0]],
  [1, 7, [0, -1], [0, 0]],
  [7, 8, [2, 0], [0, 0]],
  [1, 16, [-1, 0], [0, 0]],
  [16, 17, [1, 1], [0, 0]],
  [17, 8, [1, 0], [0, 0]],
  [1, 15, [0, 1], [0, 0]],
  [1, 9, [2, 2], [0, 0]],
  [9, 10, [1, 0], [0, 0]],
  [1, 11, [-2, -2], [0, 0]],
  [11, 12, [1, 0], [0, 0]],
  [1, 13, [3, 3], [0, 0]],
  [13, 14, [1, 0], [0, 0]],
  [1, 25, [4, 0], [0, 0]],
  [25, 26, [1, 0], [0, 0]],
  [1, 20, [0, -4], [0, 0], 0],
  [20, 6, [1, 1], [0, 0]],
  [1, 23, [0, -6], [0, 0], 0],
  [23, 24, [1, 0], [0, 0]],
]
const JUMP_POINTS = LINKS.flatMap(([a, b, at, to, explored = 1]) => [jp(a * 100 + b, a, b * 100 + a, at[0], at[1], explored), jp(b * 100 + a, b, a * 100 + b, to[0], to[1])])
const POINT = Object.fromEntries(JUMP_POINTS.map((point) => [point.WarpPointID, point]))
const ORIGIN = { SystemID: 1, Xcor: 0, Ycor: 0 }
const place = (system) => ({ SystemID: system, Xcor: M, Ycor: 0 })

// The kilometres of a run along `path` (systems), worked jump point by jump point with no search: from the origin to the first jump point, across each system from the jump point it arrives by, and from the last to the destination.
const pathKm = (path, from = ORIGIN, to = place(path[path.length - 1])) => {
  let at = from
  let km = 0

  for (let index = 0; index + 1 < path.length; index++) {
    const leaving = POINT[path[index] * 100 + path[index + 1]]

    km += Math.hypot(leaving.Xcor - at.Xcor, leaving.Ycor - at.Ycor)
    at = POINT[path[index + 1] * 100 + path[index]]
  }

  return km + Math.hypot(to.Xcor - at.Xcor, to.Ycor - at.Ycor)
}

// A row as `loadAvoidSystems` gives it: nothing dangerous, flagged or held.
const system = (id, name, over = {}) => ({ SystemID: id, Name: name, Xcor: 0, Ycor: 0, DangerRating: 0, NoAutoRoute: 0, MilitaryRestrictedSystem: 0, ControlKnown: 1, Controller: null, TradeTreaty: 0, Protection: null, ProtectionShips: 0, ProtectionKnown: 0, ...over })
const ROWS = [
  system(1, 'Harbour'),
  system(2, 'Perilous', { DangerRating: 5 }),
  system(4, 'Quiet'),
  system(5, 'Calm'),
  system(6, 'Far'),
  system(7, 'Held', { Controller: 'Zeta' }),
  system(8, 'Behind'),
  system(15, 'Pocket', { Controller: 'Zeta' }),
  system(16, 'Gatekeeper', { Controller: 'Zeta' }),
  system(17, 'Relay'),
  system(9, 'Fog', { ControlKnown: 0 }),
  system(10, 'Beyond fog'),
  system(11, 'Marked', { NoAutoRoute: 1 }),
  system(12, 'Beyond mark'),
  system(13, 'Treaty', { Controller: 'Yarn', TradeTreaty: 1 }),
  system(14, 'Beyond treaty'),
  system(25, 'Guarded', { DangerRating: 5, ProtectionShips: 2, ProtectionKnown: 2, Protection: 9 }),
  system(26, 'Beyond guard'),
  system(23, 'Veiled', { Controller: 'Zeta' }),
]
const KNOWN = new Set(ROWS.map((row) => row.SystemID))
const KEYS = ['avoidDanger', 'avoidAlien', 'skipNoAutoRoute']
const ON = (...keys) => Object.fromEntries(KEYS.map((key) => [key, keys.includes(key)]))

// The fleet and ship the pages time: a freighter that every setting suits.
const SHIP = (extra = {}) => ({ ShipID: 1, ShipName: 'Hauler', ClassName: 'Freighter', Size: 20, ShuttleStrength: 2, DesignedShuttleStrength: 2, CurrentCrew: 100, ClassCrew: 100, CargoCapacity: 1000, ColonistCapacity: 200, NavalAdminCommandID: 10, MaxSpeed: 1000, EnginePower: 10, FuelEfficiency: 1, FuelCapacity: 1e9, ShuttleTechnology: TECH, FleetID: 5, FleetName: 'Line', ShipClassID: 1, ShippingLine: 0, ...extra })
const GROUP = (ships = [SHIP()]) => ({ FleetID: 5, FleetName: 'Line', civilian: false, canTransit: true, ships, classes: [{ ShipClassID: 1, ClassName: 'Freighter', ships }] })
const PLACE = (id, name, over = {}) => ({ kind: 'system', key: `system:${id}`, name, SystemID: id, Xcor: over.Xcor || 0, Ycor: 0 })

// The colonies the plan reads: the first is short of one mineral, the others hold stock to spare when `spare` names them.
const COLONY = (id, name, systemId, x) => ({ PopulationID: id, PopName: name, SystemID: systemId, Xcor: x, Ycor: 0 })
const stocks = (spare) => [
  { colony: COLONY(1, 'Alpha', 1, 0), minerals: [{ id: 1, name: 'Duranium', stock: 0, inbound: 0, needs: 100, reserve: 0 }] },
  { colony: COLONY(2, 'Beta', 6, M), minerals: [{ id: 1, name: 'Duranium', stock: spare === 'Beta' ? 500 : 0, inbound: 0, needs: 0, reserve: 0 }] },
  { colony: COLONY(3, 'Gamma', 8, M), minerals: [{ id: 1, name: 'Duranium', stock: spare === 'Gamma' ? 500 : 0, inbound: 0, needs: 0, reserve: 0 }] },
]

const loadErrorsOf = (overrides = {}) => new Proxy({}, { get: (_target, key) => (key in overrides ? overrides[key] : null), has: () => true })
const entered = (m, route) => m.graph.routeLegs(route).filter((leg) => leg.kind === 'jump').map((leg) => leg.to.SystemID)

// A save in memory with the tables the planner's read looks at. `lacking` names the columns a table does not have, or a table that is not there at all (true).
const SAVE_COLUMNS = {
  FCT_RaceSysSurvey: ['GameID', 'RaceID', 'SystemID', 'Name', 'Xcor', 'Ycor', 'DangerRating', 'NoAutoRoute', 'MilitaryRestrictedSystem', 'ControlRaceID'],
  FCT_AlienRace: ['GameID', 'ViewRaceID', 'AlienRaceID', 'AlienRaceName', 'TradeTreaty'],
  FCT_Fleet: ['FleetID', 'GameID', 'RaceID', 'SystemID'],
  FCT_Ship: ['ShipID', 'FleetID', 'ShipClassID'],
  FCT_ShipClass: ['ShipClassID', 'ProtectionValue'],
}
const survey = (id, name, over = {}) => ({ GameID: 1, RaceID: 2, SystemID: id, Name: name, Xcor: 0, Ycor: 0, DangerRating: 0, NoAutoRoute: 0, MilitaryRestrictedSystem: 0, ControlRaceID: 0, ...over })
// Seven systems of race 2 (one of them rough, one flagged, one held by a race without a treaty, one by a race with one, one guarded, one with no known holder) and a system of another race.
const SAVE_ROWS = {
  FCT_RaceSysSurvey: [survey(1, 'Home'), survey(2, 'Rough', { DangerRating: 5 }), survey(3, 'Flag', { NoAutoRoute: 1 }), survey(4, 'Zeta', { ControlRaceID: 77 }), survey(5, 'Friend', { ControlRaceID: 78 }), survey(6, 'Guarded', { DangerRating: 5 }), survey(7, 'Unseen', { ControlRaceID: null }), survey(8, 'Other', { RaceID: 3, DangerRating: 5 })],
  FCT_AlienRace: [{ GameID: 1, ViewRaceID: 2, AlienRaceID: 77, AlienRaceName: 'Zeta', TradeTreaty: 0 }, { GameID: 1, ViewRaceID: 2, AlienRaceID: 78, AlienRaceName: 'Friend', TradeTreaty: 1 }, { GameID: 1, ViewRaceID: 3, AlienRaceID: 77, AlienRaceName: 'Elsewhere', TradeTreaty: 1 }],
  FCT_Fleet: [{ FleetID: 1, GameID: 1, RaceID: 2, SystemID: 6 }, { FleetID: 2, GameID: 1, RaceID: 3, SystemID: 2 }],
  FCT_Ship: [{ ShipID: 1, FleetID: 1, ShipClassID: 1 }, { ShipID: 2, FleetID: 2, ShipClassID: 1 }],
  FCT_ShipClass: [{ ShipClassID: 1, ProtectionValue: 9 }],
}

const memoryDatabase = async (lacking = {}, more = {}) => {
  const raw = new sqlite3.Database(':memory:')
  const run = (sql) => new Promise((resolve, reject) => raw.run(sql, (error) => (error ? reject(error) : resolve())))
  const literal = (value) => (value === null ? 'null' : typeof value === 'string' ? `'${value}'` : String(value))

  for (const [table, columns] of Object.entries(SAVE_COLUMNS)) {
    if (lacking[table] !== true) {
      const kept = columns.filter((column) => !(lacking[table] || []).includes(column))

      await run(`create table ${table} (${kept.join(', ')})`)

      for (const row of [...SAVE_ROWS[table], ...(more[table] || [])]) {
        await run(`insert into ${table} (${kept.join(', ')}) values (${kept.map((column) => literal(row[column])).join(', ')})`)
      }
    }
  }

  return { query: (sql) => new Promise((resolve, reject) => raw.all(sql, (error, rows) => (error ? reject(error) : resolve([rows])))), close: () => raw.close() }
}

// ---------- the world: the modules and the pages as shipped, or with planted faults ----------

// The text to find and its replacement for a planted fault or a benign edit: the literal `find` and `replace`, or what the pattern `at` matches (exactly once, or its first match with `first`) and `to` makes of the match.
const resolved = (edit, text) => {
  if (!edit.at) {
    return edit
  }

  const all = [...text.matchAll(new RegExp(edit.at.source, `${edit.at.flags.replace('g', '')}g`))]

  if (!all.length || (all.length !== 1 && !edit.first)) {
    throw new Error(`The pattern of ${edit.name} does not apply exactly once (${all.length} matches)`)
  }

  return { find: all[0][0], replace: edit.to(all[0]) }
}

// The sources with one edit applied.
const applied = (text, edit) => {
  const change = resolved(edit, text[edit.target])

  return { ...text, [edit.target]: patched(FILES[edit.target], text[edit.target], change.find, change.replace) }
}

const worldOf = async (edits = []) => {
  const text = edits.reduce(applied, { ...ORIGINALS })

  const utilitySources = Object.fromEntries(UTILITIES.map((name) => [name, text[name]]))
  const pageSources = {
    ...Object.fromEntries(UTILITIES.map((name) => [`utilities/${name}`, text[name]])),
    'mixins/avoid-routes': text['avoid-routes'],
    'pages/information': text.information,
    'pages/hauling': text.hauling,
    'components/page/AvoidOptions': text.options,
  }
  const loaded = await loadUtilities(NAMES, { sources: utilitySources })
  const pages = { sources: pageSources, modules: { 'mixins/load-state': LABELS_STUB } }
  const transportPage = await loadPage('pages/information', pages)
  const haulingPage = await loadPage('pages/hauling', pages)
  const fieldsOf = async (page) => {
    await loadPage(page, { sources: pageSources, modules: { 'mixins/load-state': LABELS_STUB, 'mixins/persisted-view': RECORDER } })

    return globalThis.__persistedFields
  }

  return { text, m: { safe: loaded['safe-routes'], graph: loaded['jump-graph'], plan: loaded['route-plan'], provenance: loaded.provenance, transport: loaded.transport, haul: loaded['haul-plan'] }, transportPage, haulingPage, transportFields: await fieldsOf('pages/information'), haulingFields: await fieldsOf('pages/hauling') }
}

// ---------- the template helpers ----------

const compiled = (source) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source })
  const descriptor = parsed.descriptor || parsed

  return compiler.compileTemplate({ source: descriptor.template.content, filename: 'component.vue', id: 'component' })
}

const elementsOf = (ast) => {
  const found = []
  const visit = (node) => {
    if (node.type === 1) {
      found.push(node)
      node.children.forEach(visit)
      ;(node.ifConditions || []).slice(1).forEach((branch) => visit(branch.block))
      Object.values(node.scopedSlots || {}).forEach(visit)
    }
  }

  visit(ast)

  return found
}

const staticTexts = (ast) => {
  const texts = []
  const visit = (node) => {
    if (node.type === 3) {
      texts.push(node.text)
    } else if (node.type === 1) {
      node.children.forEach(visit)
      ;(node.ifConditions || []).slice(1).forEach((branch) => visit(branch.block))
      Object.values(node.scopedSlots || {}).forEach(visit)
    }
  }

  visit(ast)

  return texts
}

const evaluate = (expression, scope) => require('vm').runInNewContext(`with (scope) { (${expression}) }`, { scope })

const bindingsOf = (element) => {
  const props = {}
  const events = {}

  Object.entries(element.attrsMap).forEach(([name, expression]) => {
    const bound = name.match(/^(?::|v-bind:)([\w-]+)$/)
    const handled = name.match(/^(?:@|v-on:)([\w-]+)$/)

    if (bound) {
      props[bound[1]] = expression
    } else if (handled) {
      events[handled[1]] = expression
    }
  })

  return { props, events }
}

const PRONOUNS = /\b(I|me|my|mine|you|your|we|our)\b/i

// ---------- the statements without a save ----------

const fixtures = (world) => {
  const all = []
  const add = (name, run) => all.push([name, run])
  const { m } = world
  const { safe, graph } = m
  const rules = (settings, rows = ROWS) => safe.avoidRules(rows, settings)
  const plan = (destination, settings, origin = ORIGIN, rows = ROWS) => safe.planRun({ jumpPoints: JUMP_POINTS, origin, destination: place(destination), avoid: rules(settings, rows) })
  const search = (destination, order = 'jumps') => graph.searchRoutes(JUMP_POINTS, [ORIGIN], { order }).toPlace(place(destination))
  const label = (key) => safe.AVOID_OPTIONS.find((option) => option.key === key).label
  const idsOf = (list) => list.map((entry) => entry.SystemID)
  const sameSet = (actual, expected) => assert.deepEqual([...actual].sort((a, b) => a - b), [...expected].sort((a, b) => a - b))

  add('baseline: with every setting off, a run is the Route Finder\'s own search: the same jumps and kilometres, nothing avoided, no detour, nothing cut off', () => {
    for (const destination of [6, 8, 10, 12, 14, 26]) {
      const run = plan(destination, ON())
      const direct = search(destination)

      assert.equal(run.status, 'open')
      assert.equal(run.route.jumps, direct.jumps)
      near(run.route.km, direct.km)
      assert.equal(run.detour, null)
      assert.deepEqual(run.cutOff, [])
    }

    near(plan(6, ON()).route.km, pathKm([1, 2, 6]))
    near(plan(8, ON()).route.km, pathKm([1, 7, 8]))
    assert.equal(safe.planRun({ jumpPoints: JUMP_POINTS, origin: ORIGIN, destination: place(6), avoid: null }).status, 'open')
  })

  add('detour: a danger the race\'s ships do not outweigh sends the run the long way round, with the allowed path\'s jumps and kilometres, and the run names the system avoided and the setting responsible', () => {
    const run = plan(6, ON('avoidDanger'))
    const text = safe.detourText(run.detour, String)

    assert.equal(run.status, 'detour')
    assert.equal(run.route.jumps, 3)
    near(run.route.km, pathKm([1, 4, 5, 6]))
    near(run.baseline.km, pathKm([1, 2, 6]))
    assert.deepEqual(entered(m, run.route), [4, 5, 6])
    assert.deepEqual(idsOf(run.detour.barred), [2])
    assert.equal(run.detour.barred[0].option, 'avoidDanger')
    assert.equal(run.detour.barred[0].basis, 'observed')
    near(run.detour.extraKm, pathKm([1, 4, 5, 6]) - pathKm([1, 2, 6]))
    near(run.detour.km, pathKm([1, 4, 5, 6]))
    near(run.detour.baseline.km, pathKm([1, 2, 6]))
    assert.equal(run.detour.jumps, 3)
    assert.equal(run.detour.baseline.jumps, 2)
    assert.equal(run.detour.extraJumps, 1)
    assert.ok(text.includes('Perilous') && text.includes(label('avoidDanger')), 'the detour names the system and the setting')
    assert.equal(plan(26, ON('avoidDanger')).status, 'open', 'a danger the race\'s ships outweigh is not avoided')
    assert.equal(plan(6, ON('avoidAlien')).status, 'open', 'a danger is not avoided by another setting')
  })

  add('blocked: a run the settings cut off has no route and names the observed systems that cut it off, nearest the baseline route first, with the setting responsible', () => {
    const run = plan(8, ON('avoidAlien'))
    const text = safe.cutOffText(run.cutOff)

    assert.equal(run.status, 'blocked')
    assert.equal(run.route, null)
    assert.ok(run.baseline, 'the baseline route is kept')
    assert.deepEqual(idsOf(run.cutOff), [7, 16])
    assert.deepEqual(run.cutOff.map((entry) => entry.onRoute), [true, false])
    run.cutOff.forEach((entry) => {
      assert.equal(entry.option, 'avoidAlien')
      assert.equal(entry.basis, 'observed')
    })
    assert.ok(text.includes('Held') && text.includes('Gatekeeper') && text.includes(label('avoidAlien')), 'the text names the systems and the setting')
    assert.ok(!text.includes('Pocket') && !text.includes('Relay'), 'a dead end and a system nothing bars are not named')
    assert.equal(plan(8, ON('avoidDanger')).status, 'open', 'another setting does not cut it off')
    assert.equal(plan(8, ON('avoidDanger', 'avoidAlien', 'skipNoAutoRoute')).status, 'blocked')
  })

  add('basis: an unknown control, a flag the player set and an observed holder are told apart, and each names its own setting', () => {
    const unknown = plan(10, ON('avoidAlien'))
    const flagged = plan(12, ON('skipNoAutoRoute'))
    const held = plan(8, ON('avoidAlien'))

    assert.equal(unknown.status, 'blocked')
    assert.deepEqual(unknown.cutOff.map((entry) => [entry.SystemID, entry.option, entry.basis, entry.assumed]), [[9, 'avoidAlien', 'unknown', true]])
    assert.deepEqual(flagged.cutOff.map((entry) => [entry.SystemID, entry.option, entry.basis, entry.assumed]), [[11, 'skipNoAutoRoute', 'defined', false]])
    assert.deepEqual(held.cutOff.map((entry) => [entry.option, entry.basis, entry.assumed]), [['avoidAlien', 'observed', false], ['avoidAlien', 'observed', false]])
    assert.equal(plan(10, ON('skipNoAutoRoute', 'avoidDanger')).status, 'open', 'the unknown control bars only for the setting that reads it')
    assert.equal(plan(14, ON('avoidAlien')).status, 'open', 'a holder with a trade treaty is not avoided')
    assert.equal(rules(ON('avoidAlien')).assumed, 1)
    assert.equal(rules(ON()).assumed, 0)
    assert.equal(rules(ON()).active, false)
    assert.equal(rules(ON('avoidAlien')).active, true)

    const blank = rules(ON('avoidDanger'), [system(99, 'Blank', { DangerRating: null })])

    assert.equal(blank.details[99].basis, 'unknown', 'a rating the save lacks is avoided as unknown')
    assert.equal(blank.details[99].option, 'avoidDanger')
    assert.equal(rules(ON('avoidAlien'), [system(98, 'Mine', { Controller: null, ControlKnown: 1 })]).canEnter(98), true, 'a system held by no one, or by the race, is not avoided')
  })

  add('unobserved: a jump point not explored is never crossed, and a system the race holds no row for is never named', () => {
    const settings = ON('avoidDanger', 'avoidAlien', 'skipNoAutoRoute')
    const run = plan(6, ON('avoidDanger'))

    assert.deepEqual(entered(m, plan(6, settings).route), [4, 5, 6], 'the shortcut behind an unexplored jump point is not used')
    assert.equal(run.route.jumps, 3)
    assert.equal(plan(24, ON()).status, 'unreached', 'a destination behind an unexplored jump point has no route at all')
    assert.deepEqual(plan(24, settings).cutOff, [])
    assert.deepEqual(safe.cutOffOf({ jumpPoints: JUMP_POINTS, origin: ORIGIN, destination: place(24), avoid: rules(settings) }), [], 'a barred system behind an unexplored jump point is not named')

    for (const destination of [6, 8, 10, 12, 14, 24, 26]) {
      for (const settingsOn of [ON('avoidDanger'), ON('avoidAlien'), ON('skipNoAutoRoute'), settings]) {
        const found = plan(destination, settingsOn)
        const named = [...found.cutOff, ...(found.detour ? found.detour.barred : [])].map((entry) => entry.SystemID)

        named.forEach((systemId) => assert.ok(KNOWN.has(systemId), `system ${systemId} has a row`))
        assert.ok(!named.includes(20) && !named.includes(24), 'a system with no row is not named')
      }
    }
  })

  add('frontier: a barred dead end beside the origin and a system behind the barred ones are never named as cutting the run off', () => {
    const named = idsOf(plan(8, ON('avoidAlien')).cutOff)

    assert.ok(!named.includes(15), 'the dead end')
    assert.ok(!named.includes(17), 'a system that is not barred')
    assert.ok(!named.includes(23), 'a barred system behind an unexplored jump point')
    sameSet(named, [7, 16])
  })

  add('origin: the system a run starts in is never avoided and the destination always is, going and coming back', () => {
    const avoid = rules(ON('avoidDanger'))
    const out = safe.planRun({ jumpPoints: JUMP_POINTS, origin: place(2), destination: place(6), avoid })
    const back = safe.planRun({ jumpPoints: JUMP_POINTS, origin: ORIGIN, destination: place(2), avoid })

    assert.equal(avoid.canEnter(2), false, 'the system is avoided')
    assert.equal(out.status, 'open', 'a run leaves the system it starts in freely')
    assert.equal(out.route.jumps, 1)
    assert.equal(out.detour, null)
    assert.equal(back.status, 'blocked', 'the same system as a destination is not entered')
    assert.equal(back.route, null)
    assert.ok(back.baseline)
    sameSet(idsOf(back.cutOff), [2])
  })

  add('clear: clearing the settings restores the baseline run and the baseline plan', () => {
    for (const destination of [6, 8, 10, 12, 14, 26]) {
      const cleared = plan(destination, ON())
      const direct = search(destination)

      assert.equal(cleared.route.jumps, direct.jumps)
      near(cleared.route.km, direct.km)
      assert.equal(cleared.status, 'open')
    }

    for (const spare of ['Beta', 'Gamma']) {
      const without = m.haul.planHauls(stocks(spare), { jumpPoints: JUMP_POINTS })

      assert.deepEqual(m.haul.planHauls(stocks(spare), { jumpPoints: JUMP_POINTS, avoid: rules(ON()) }), without)
      assert.deepEqual(m.haul.planHauls(stocks(spare), { jumpPoints: JUMP_POINTS, avoid: null }), without)
    }
  })

  add('hauls: a haul is the allowed path\'s distance and says what it avoids, and a colony the settings cut off is named with the systems that cut it off', () => {
    const open = m.haul.planHauls(stocks('Beta'), { jumpPoints: JUMP_POINTS })
    const safer = m.haul.planHauls(stocks('Beta'), { jumpPoints: JUMP_POINTS, avoid: rules(ON('avoidDanger')) })
    const cut = m.haul.planHauls(stocks('Gamma'), { jumpPoints: JUMP_POINTS, avoid: rules(ON('avoidAlien')) })

    assert.equal(open.hauls.length, 1)
    near(open.hauls[0].km, pathKm([1, 2, 6]))
    assert.equal(safer.hauls.length, 1)
    near(safer.hauls[0].km, pathKm([6, 20, 1], place(6), ORIGIN))
    assert.equal(safer.hauls[0].jumps, 2)
    assert.deepEqual(idsOf(safer.hauls[0].detour.barred), [2])
    assert.equal(safer.hauls[0].tonnes, open.hauls[0].tonnes)
    assert.equal(cut.hauls.length, 0)
    assert.equal(cut.unmet.length, 1)
    assert.equal(cut.unmet[0].cut.length, 1)
    assert.equal(cut.unmet[0].cut[0].colony.PopName, 'Gamma')
    sameSet(idsOf(cut.unmet[0].cut[0].cutOff), [7, 16])
    assert.equal(m.haul.planHauls(stocks('Gamma'), { jumpPoints: JUMP_POINTS, avoid: rules(ON('avoidDanger')) }).hauls.length, 1, 'another setting does not cut it off')
  })

  add('haulcut: a colony with stock that no allowed route reaches is not a source, and what it holds is named only where it could have covered the shortfall', () => {
    const none = m.haul.planHauls(stocks('Nobody'), { jumpPoints: JUMP_POINTS, avoid: rules(ON('avoidAlien')) })

    assert.equal(none.unmet[0].cut.length, 0, 'no colony holds stock to spare, so none is named')

    const cut = m.haul.planHauls(stocks('Gamma'), { jumpPoints: JUMP_POINTS, avoid: rules(ON('avoidAlien')) })

    near(cut.unmet[0].cut[0].tonnes, 500)
  })

  add('fields: the settings persist per race, one key each for the page, off until chosen and only ever a yes or a no', () => {
    const lists = [world.transportFields, world.haulingFields]
    const keys = lists.flatMap((fields) => KEYS.map((key) => fields[key].key))

    assert.equal(new Set(keys).size, keys.length, 'the keys differ between the pages and between the settings')
    lists.forEach((fields) => {
      const others = Object.entries(fields).filter(([name]) => !KEYS.includes(name)).map(([, field]) => field.key || (field.table && field.key))

      KEYS.forEach((key) => {
        assert.equal(fields[key].scope, 'race')
        assert.equal(fields[key].default, false)
        assert.equal(fields[key].valid(true), true)
        assert.equal(fields[key].valid(false), true)
        assert.equal(fields[key].valid('yes'), false)
        assert.equal(fields[key].valid(null), false)
        assert.ok(!others.includes(fields[key].key), 'no other field shares the key')
      })
    })
    assert.equal(safe.avoidFields('x').avoidDanger.key, 'xAvoidDanger')
  })

  const transportVm = (settings, over = {}) => instantiate(world.transportPage, { $store: over.store || STORE, database: over.database || null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(over.errors), avoidSystems: ROWS, jumpPoints: JUMP_POINTS, systems: [], lagrangePoints: [], origin: PLACE(1, 'Harbour'), destination: { ...PLACE(over.destination || 6, 'Far'), Xcor: M }, groups: [GROUP()], formulaVersion: VERSION, handlingSupport: null, ...settings, ...over.data } })
  const tripAt = (vm, km) => m.transport.roundTrip([SHIP()], km, vm.endpoints, TECH, { colonists: true, version: VERSION, support: vm.officerSupport })

  add('figures: on Transport a detour takes distance, time, fuel and yearly capacity from the same allowed path, a cut-off run names its systems, and clearing the settings restores the baseline row', () => {
    const base = transportVm(ON()).rows[0]
    const safer = transportVm(ON('avoidDanger')).rows[0]
    const baseTrip = tripAt(transportVm(ON()), pathKm([1, 2, 6]))
    const saferTrip = tripAt(transportVm(ON()), pathKm([1, 4, 5, 6]))

    assert.equal(base.status, 'ok')
    assert.equal(safer.status, 'ok')
    assert.equal(base.jumps, 2)
    near(base.km, pathKm([1, 2, 6]))
    assert.equal(safer.jumps, 3)
    near(safer.km, pathKm([1, 4, 5, 6]))
    near(base.tripSeconds, baseTrip.tripSeconds)
    near(safer.tripSeconds, saferTrip.tripSeconds)
    near(safer.fuel, saferTrip.fuelPerShip)
    near(base.fuel, baseTrip.fuelPerShip)
    near(safer.tonsYear, 1000 * saferTrip.trips)
    near(base.tonsYear, 1000 * baseTrip.trips)
    assert.ok(safer.tripSeconds > base.tripSeconds && safer.fuel > base.fuel && safer.tonsYear < base.tonsYear, 'time, burn and throughput move together')
    assert.ok(safer.detourText.includes('Perilous'), 'the row says what it avoids')
    assert.equal(base.detourText, '')
    assert.ok(safer.pathResult && safer.pathResult.status !== 'unavailable', 'the distance carries a provenance result')
    assert.equal(base.pathResult, null)

    const blocked = transportVm(ON('avoidAlien'), { destination: 8 })
    const row = blocked.rows[0]

    assert.equal(row.status, 'noroute')
    assert.equal(row.tripSeconds, null)
    assert.equal(row.tonsYear, null)
    assert.equal(row.fuel, null)
    assert.ok(row.note.includes('Held') && row.note.includes('Gatekeeper') && row.note.includes(label('avoidAlien')), 'the note names the systems and the setting')
    assert.ok(blocked.problems.some((problem) => problem.text.includes('Held')), 'the problem alert says it too')

    const cleared = transportVm(ON('avoidDanger'))

    cleared.avoidDanger = false
    assert.deepEqual({ ...cleared.rows[0], provenance: null, estimate: null, handlingRows: null, limiting: null }, { ...base, provenance: null, estimate: null, handlingRows: null, limiting: null }, 'the cleared row is the baseline row')
  })

  add('pending: while a setting is on and the systems it reads are not in, or the read failed, nothing is planned over a guess and the page says why; with nothing on the read is not waited for', () => {
    for (const state of [undefined, 'boom']) {
      const vm = transportVm(ON('avoidDanger'), { errors: { avoidSystems: state } })
      const reach = vm.reachOf(GROUP())
      const row = vm.rows[0]

      assert.equal(vm.avoidPending, true)
      assert.equal(reach.route, null)
      assert.equal(reach.pending, true)
      assert.equal(row.status, 'unknown')
      assert.equal(row.km, 0)
      assert.equal(row.tripSeconds, null)
      assert.equal(row.tonsYear, null)
      assert.equal(row.provenance.status, 'unavailable')
      assert.ok(vm.avoidNote && vm.avoidNote.text.length > 0)
      assert.equal(row.note, vm.avoidNote.text)
      assert.equal(vm.avoidState.failed, state === 'boom')

      if (state) {
        assert.ok(vm.avoidNote.text.includes(state), 'the note says what failed')
      }

      assert.equal(vm.tiles.length > 0, true)
    }

    const idle = transportVm(ON(), { errors: { avoidSystems: undefined } })

    assert.equal(idle.avoidPending, false)
    assert.equal(idle.avoidNote, null)
    assert.equal(idle.rows[0].status, 'ok')
    assert.equal(idle.failedInputs.length, 0, 'the read holds nothing back')

    const failed = transportVm(ON(), { errors: { avoidSystems: 'boom' } })

    assert.equal(failed.failedInputs.length, 0)
    assert.equal(failed.inputsLoaded, true)

    const hauling = instantiate(world.haulingPage, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf({ avoidSystems: undefined }), avoidSystems: ROWS, jumpPoints: JUMP_POINTS, colonyStocks: stocks('Beta'), classes: [], mineralDeliveries: {}, formulaVersion: VERSION, avoidDanger: true } })

    assert.deepEqual({ hauls: hauling.plan.hauls, unmet: hauling.plan.unmet }, { hauls: [], unmet: [] })
    assert.equal(hauling.planEmptyText, hauling.avoidNote.text)
  })

  add('hauling: the Hauling page plans under its own settings, shows the detour and the cut-off systems, and clearing them restores the baseline plan', () => {
    const vm = (settings, spare, extra = {}) => instantiate(world.haulingPage, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(), avoidSystems: ROWS, jumpPoints: JUMP_POINTS, colonyStocks: stocks(spare), classes: [], mineralDeliveries: {}, formulaVersion: VERSION, shuttleTechnology: TECH, ...settings, ...extra } })
    const baseline = vm(ON(), 'Beta')
    const safer = vm(ON('avoidDanger'), 'Beta')
    const cut = vm(ON('avoidAlien'), 'Gamma')

    near(baseline.planRows[0].km, pathKm([1, 2, 6]))
    assert.equal(baseline.planRows[0].detourText, '')
    assert.equal(baseline.planRows[0].pathResult, null)
    near(safer.planRows[0].km, pathKm([6, 20, 1], place(6), ORIGIN))
    assert.equal(safer.planRows[0].jumps, 2)
    assert.ok(safer.planRows[0].detourText.includes('Perilous'))
    assert.ok(safer.planRows[0].pathResult && safer.planRows[0].pathResult.status !== 'unavailable')
    assert.equal(cut.planRows.length, 0)
    assert.equal(cut.unmetRows.length, 1)
    assert.ok(cut.unmetRows[0].cutTexts.length === 1 && cut.unmetRows[0].cutTexts[0].includes('Held') && cut.unmetRows[0].cutTexts[0].includes('Gamma'), 'the unmet row names the colony and the systems')
    assert.equal(baseline.unmetRows[0] === undefined, true)

    const cleared = vm(ON('avoidDanger'), 'Beta')

    cleared.avoidDanger = false
    assert.deepEqual(cleared.plan, baseline.plan)
    near(cleared.planRows[0].km, pathKm([1, 2, 6]))

    const freight = { ...SHIP(), ClassName: 'Freighter' }
    const timed = (km) => m.haul.haulByClass({ ...baseline.plan.hauls[0], km }, freight, TECH, VERSION)
    const slow = timed(pathKm([1, 4, 5, 6]))
    const fast = timed(pathKm([1, 2, 6]))

    assert.ok(slow.travelSeconds > fast.travelSeconds && slow.fuelPerShip > fast.fuelPerShip, 'the way round takes longer and burns more')
  })

  add('reads: each page tracks the read under the key it labels, reads the rows through the schema-aware loader of the planner, so a column the save lacks leaves the other settings working, and the loader sends the race and game', async () => {
    for (const page of [world.transportPage, world.haulingPage]) {
      const full = await memoryDatabase()
      const queries = []
      const database = { query: async (sql) => { queries.push(sql); return full.query(sql) } }
      const vm = instantiate(page, { $store: STORE, database, GameID: 1, RaceID: 2, data: { loadErrors: {} } })

      try {
        assert.ok('avoidSystems' in vm.inputLabels, 'labelled')
        await vm.runAsync('avoidSystems')
        assert.equal(vm.loadErrors.avoidSystems, null)

        const select = queries[queries.length - 1]

        assert.ok(/GameID = 1\b/.test(select) && /RaceID = 2\b/.test(select), 'the query is for the race')
        assert.deepEqual([...vm.avoidSystems], [...(await m.safe.loadPlannedAvoidSystems(full, { GameID: 1, RaceID: 2 }))])
        assert.ok(Object.isFrozen(vm.avoidSystems))
      } finally {
        full.close()
      }

      const partial = await memoryDatabase({ FCT_RaceSysSurvey: ['NoAutoRoute'], FCT_AlienRace: true })
      const lacking = instantiate(page, { $store: STORE, database: partial, GameID: 1, RaceID: 2, data: { loadErrors: {} } })

      try {
        await lacking.runAsync('avoidSystems')
        assert.equal(lacking.loadErrors.avoidSystems, null, 'a column the save lacks does not fail the read')
        assert.ok(lacking.avoidSystems.length > 0 && lacking.avoidSystems.every((row) => row.NoAutoRoute === null), 'the flag reads as unknown')
      } finally {
        partial.close()
      }

      const broken = instantiate(page, { $store: STORE, database: { query: async () => { throw new Error('no such column') } }, GameID: 1, RaceID: 2, data: { loadErrors: {} } })

      await assert.rejects(() => broken.runAsync('avoidSystems'))
      assert.equal(broken.loadErrors.avoidSystems, 'no such column')
    }
  })

  add('template: each page mounts the settings menu bound to its own settings, say what is avoided in the rows, and keep a summary on every section', () => {
    for (const [page, source] of [[world.transportPage, world.text.information], [world.haulingPage, world.text.hauling]]) {
      const compiledTemplate = compiled(source)

      assert.deepEqual(compiledTemplate.errors, [])

      const elements = elementsOf(compiledTemplate.ast)
      const menu = elements.filter((element) => element.tag === 'avoid-options')
      const vm = instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(), avoidSystems: ROWS, jumpPoints: JUMP_POINTS, avoidAlien: true, groups: [GROUP()], colonyStocks: stocks('Beta'), classes: [], mineralDeliveries: {} } })

      assert.equal(menu.length, 1)

      const { props, events } = bindingsOf(menu[0])

      assert.deepEqual(evaluate(props.options, vm), vm.avoidOptionList)
      assert.deepEqual(evaluate(props.settings, vm), ON('avoidAlien'))
      assert.equal(evaluate(props.count, vm), 1)
      vm.setAvoid('avoidDanger', true)
      assert.equal(vm.avoidDanger, true)
      assert.equal(events.change, 'setAvoid')

      const note = elements.filter((element) => element.attrsMap['data-avoid-note'] !== undefined)

      assert.equal(note.length, 1)
      assert.ok(!evaluate(note[0].if, vm), 'no note while the read is in')

      const waiting = instantiate(page, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf({ avoidSystems: undefined }), avoidDanger: true } })

      assert.ok(evaluate(note[0].if, waiting), 'a note while it is not')

      const detour = elements.filter((element) => element.attrsMap['data-detour'] !== undefined)

      assert.equal(detour.length, 1)
      assert.ok(evaluate(detour[0].if, Object.assign(Object.create(vm), { item: { detourText: 'x' } })))
      assert.ok(!evaluate(detour[0].if, Object.assign(Object.create(vm), { item: { detourText: '' } })))
      elements.filter((element) => (element.staticClass || '').includes('panel') && element.tag === 'v-card').forEach((panel) => assert.ok(panel.attrsMap['data-summary'], 'a section without a summary'))
    }
  })

  add('shared: the Route Finder reads the settings and the systems through the same module as the pages and keeps no copy of them', () => {
    const acorn = require('acorn')
    const script = (text) => { const parsed = require('vue/compiler-sfc').parse({ source: text }); return (parsed.descriptor || parsed).script.content }
    const importsOf = (text) => acorn.parse(script(text), { ecmaVersion: 'latest', sourceType: 'module' }).body.filter((node) => node.type === 'ImportDeclaration' && /safe-routes$/.test(node.source.value)).flatMap((node) => node.specifiers.map((specifier) => specifier.imported.name))

    assert.ok(['AVOID_OPTIONS', 'loadAvoidSystems'].every((name) => importsOf(world.text.routes).includes(name)), 'the Route Finder')
    assert.ok(['avoidFields', 'loadPlannedAvoidSystems', 'detourText', 'cutOffText', 'pathResult', 'unreadResult'].every((name) => importsOf(world.text.hauling).includes(name)), 'Hauling')
    assert.ok(['avoidFields', 'loadPlannedAvoidSystems', 'detourText', 'cutOffText', 'pathResult', 'planRun', 'unreadResult'].every((name) => importsOf(world.text.information).includes(name)), 'Transport')
    assert.ok(!world.text.routes.includes('FCT_RaceSysSurvey.DangerRating'), 'the Route Finder keeps no query of its own')
    assert.ok(Array.isArray(safe.AVOID_OPTIONS) && safe.AVOID_OPTIONS.map((option) => option.key).join() === KEYS.join())
  })

  add('voice: what the settings say is impersonal, and no tracked file of the settings cites the game\'s source', () => {
    const vm = transportVm(ON('avoidDanger'), { errors: { avoidSystems: 'boom' } })
    const texts = [
      ...safe.AVOID_OPTIONS.flatMap((option) => [option.label, option.hint]),
      vm.avoidNote.text,
      safe.detourText(plan(6, ON('avoidDanger')).detour, String),
      safe.cutOffText(plan(8, ON('avoidAlien')).cutOff),
      safe.cutOffText([]),
      ...staticTexts(compiled(world.text.options).ast).filter((text) => text.trim()),
      ...Object.values(plan(8, ON('avoidAlien', 'skipNoAutoRoute', 'avoidDanger')).cutOff).map((entry) => entry.reason),
    ]

    texts.forEach((text) => assert.ok(!PRONOUNS.test(text), `a pronoun in: ${text}`))
    ;['safe-routes', 'avoid-routes', 'options'].forEach((key) => assert.ok(!/\b\w+\.cs\b/.test(world.text[key]), `${key} names a source file`))
  })

  add('direction: a haul is planned the way it sails, from the colony that gives to the one that is short, so it is allowed exactly when a run between the same two places is, over the same kilometres, and a short colony in a barred system is not supplied', () => {
    const systems = [1, 2, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 25, 26]
    const colonyIn = (id, name, systemId) => COLONY(id, name, systemId, systemId % 2 ? M : 0)
    const stock = (taker, giver) => [{ colony: taker, minerals: [{ id: 1, name: 'Duranium', stock: 0, inbound: 0, needs: 100, reserve: 0 }] }, { colony: giver, minerals: [{ id: 1, name: 'Duranium', stock: 500, inbound: 0, needs: 0, reserve: 0 }] }]
    const settingsList = [ON('avoidDanger'), ON('avoidAlien'), ON('skipNoAutoRoute'), ON('avoidDanger', 'avoidAlien', 'skipNoAutoRoute')]
    let compared = 0
    let supplied = 0

    for (const settings of settingsList) {
      const avoid = rules(settings)

      for (const from of systems) {
        for (const to of systems) {
          if (from !== to) {
            const giver = colonyIn(2, 'Giver', from)
            const taker = colonyIn(1, 'Taker', to)
            const found = m.haul.planHauls(stock(taker, giver), { jumpPoints: JUMP_POINTS, avoid })
            const run = safe.planRun({ jumpPoints: JUMP_POINTS, origin: { SystemID: from, Xcor: giver.Xcor, Ycor: giver.Ycor }, destination: { SystemID: to, Xcor: taker.Xcor, Ycor: taker.Ycor }, order: 'km', avoid })

            assert.equal(found.hauls.length, run.route ? 1 : 0, `a haul from system ${from} to ${to} under ${JSON.stringify(settings)} is allowed exactly when the run is`)

            if (run.route) {
              near(found.hauls[0].km, run.route.km)
              assert.equal(found.hauls[0].jumps, run.route.jumps)
              supplied++
            }

            compared++
          }
        }
      }
    }

    assert.ok(supplied > 0 && supplied < compared, 'the pairs are told apart')

    const avoid = rules(ON('avoidDanger'))
    const barred = m.haul.planHauls(stock(colonyIn(1, 'Taker', 2), colonyIn(2, 'Giver', 6)), { jumpPoints: JUMP_POINTS, avoid })
    const leaving = m.haul.planHauls(stock(colonyIn(1, 'Taker', 6), colonyIn(2, 'Giver', 2)), { jumpPoints: JUMP_POINTS, avoid })

    assert.equal(barred.hauls.length, 0, 'a short colony in a barred system is not supplied')
    assert.equal(barred.unmet.length, 1)
    assert.deepEqual(barred.unmet[0].cut.map((source) => source.colony.PopName), ['Giver'])
    sameSet(idsOf(barred.unmet[0].cut[0].cutOff), [2])
    assert.equal(leaving.hauls.length, 1, 'a giving colony in a barred system is left freely')
    assert.equal(leaving.hauls[0].jumps, 1)
  })

  add('schema: the planner\'s read gives the Route Finder\'s rows on a save with every column, and a column or table the save lacks reads as unknown for what needs it while the other settings keep working', async () => {
    const ids = { GameID: 1, RaceID: 2 }
    const read = async (lacking, loader = safe.loadPlannedAvoidSystems, more = {}) => {
      const database = await memoryDatabase(lacking, more)

      try {
        return await loader(database, ids)
      } finally {
        database.close()
      }
    }
    const everyId = [1, 2, 3, 4, 5, 6, 7]
    const barredIds = (rows, key) => Object.keys(rules(ON(key), rows).details).map(Number).sort((a, b) => a - b)
    const detailsOf = (rows, key) => rules(ON(key), rows).details
    const same = (rows, key) => assert.deepEqual(detailsOf(rows, key), detailsOf(full, key), `${key} is unchanged`)
    const byId = (rows) => [...rows].sort((a, b) => a.SystemID - b.SystemID)
    const full = await read({})
    const finder = await read({}, safe.loadAvoidSystems)

    assert.deepEqual(byId(full), byId(finder), 'the Route Finder\'s own rows')
    assert.equal(full.length, everyId.length)
    assert.ok(Object.isFrozen(full))
    assert.deepEqual(barredIds(full, 'avoidDanger'), [2])
    assert.deepEqual(barredIds(full, 'avoidAlien'), [4, 7])
    assert.deepEqual(barredIds(full, 'skipNoAutoRoute'), [3])

    const cases = [
      ['NoAutoRoute', { FCT_RaceSysSurvey: ['NoAutoRoute'] }],
      ['DangerRating', { FCT_RaceSysSurvey: ['DangerRating'] }],
      ['MilitaryRestrictedSystem', { FCT_RaceSysSurvey: ['MilitaryRestrictedSystem'] }],
      ['ControlRaceID', { FCT_RaceSysSurvey: ['ControlRaceID'] }],
      ['the alien races', { FCT_AlienRace: true }],
      ['AlienRaceName', { FCT_AlienRace: ['AlienRaceName'] }],
      ['TradeTreaty', { FCT_AlienRace: ['TradeTreaty'] }],
      ['ProtectionValue', { FCT_ShipClass: ['ProtectionValue'] }],
      ['the fleets', { FCT_Fleet: true }],
    ]
    const rows = Object.fromEntries(await Promise.all(cases.map(async ([name, lacking]) => [name, await read(lacking)])))

    cases.forEach(([name]) => {
      assert.deepEqual(Object.keys(rows[name][0]).sort(), Object.keys(full[0]).sort(), `${name}: the rows keep their shape`)
      assert.equal(rows[name].length, everyId.length, `${name}: one row for each system`)
    })
    rows.NoAutoRoute.forEach((row) => assert.equal(row.NoAutoRoute, null))
    ;['avoidDanger', 'avoidAlien'].forEach((key) => same(rows.NoAutoRoute, key))
    assert.deepEqual(barredIds(rows.NoAutoRoute, 'skipNoAutoRoute'), everyId)
    assert.ok(Object.values(detailsOf(rows.NoAutoRoute, 'skipNoAutoRoute')).every((found) => found.basis === 'unknown'))
    rows.DangerRating.forEach((row) => assert.equal(row.DangerRating, null))
    ;['avoidAlien', 'skipNoAutoRoute'].forEach((key) => same(rows.DangerRating, key))
    assert.deepEqual(barredIds(rows.DangerRating, 'avoidDanger'), everyId)
    assert.ok(Object.values(detailsOf(rows.DangerRating, 'avoidDanger')).every((found) => found.basis === 'unknown'))
    rows.MilitaryRestrictedSystem.forEach((row) => assert.equal(row.MilitaryRestrictedSystem, null))
    KEYS.forEach((key) => same(rows.MilitaryRestrictedSystem, key))
    ;['avoidDanger', 'skipNoAutoRoute'].forEach((key) => same(rows.ControlRaceID, key))
    assert.deepEqual(barredIds(rows.ControlRaceID, 'avoidAlien'), everyId)
    assert.ok(Object.values(detailsOf(rows.ControlRaceID, 'avoidAlien')).every((found) => found.basis === 'unknown'))
    ;['avoidDanger', 'skipNoAutoRoute'].forEach((key) => same(rows['the alien races'], key))
    assert.deepEqual(barredIds(rows['the alien races'], 'avoidAlien'), [4, 5, 7], 'a holder with no alien race row is avoided')
    assert.ok(detailsOf(rows['the alien races'], 'avoidAlien')[5].assumed && detailsOf(rows['the alien races'], 'avoidAlien')[4].basis === 'unknown')
    ;['avoidDanger', 'skipNoAutoRoute'].forEach((key) => same(rows.AlienRaceName, key))
    assert.deepEqual(barredIds(rows.AlienRaceName, 'avoidAlien'), [4, 7], 'the treaty is still read')
    assert.equal(detailsOf(rows.AlienRaceName, 'avoidAlien')[4].assumed, false)
    assert.ok(rows.AlienRaceName.find((row) => row.SystemID === 4).Controller !== 'Zeta', 'the holder\'s name is not known')
    ;['avoidDanger', 'skipNoAutoRoute'].forEach((key) => same(rows.TradeTreaty, key))
    assert.deepEqual(barredIds(rows.TradeTreaty, 'avoidAlien'), [4, 5, 7], 'a holder whose treaty is not known is avoided')
    assert.ok(detailsOf(rows.TradeTreaty, 'avoidAlien')[5].assumed)
    assert.ok(rows.TradeTreaty.filter((row) => [4, 5].includes(row.SystemID)).every((row) => row.TradeTreaty === null), 'a contact whose treaty column is missing has an unknown treaty')
    assert.ok(rows.TradeTreaty.filter((row) => ![4, 5].includes(row.SystemID)).every((row) => row.TradeTreaty === full.find((found) => found.SystemID === row.SystemID).TradeTreaty), 'a system with no contact keeps the neutral treaty value')
    assert.ok(rows['the alien races'].every((row) => row.TradeTreaty === null), 'with no table to look the contact up in the treaty is unknown')
    assert.ok(rows.ControlRaceID.every((row) => row.TradeTreaty === null), 'with no owner column the treaty is unknown')

    const stranger = { FCT_RaceSysSurvey: [survey(9, 'Stranger', { ControlRaceID: 99 })] }
    const withStranger = await read({ FCT_AlienRace: ['TradeTreaty'] }, safe.loadPlannedAvoidSystems, stranger)
    const fullStranger = await read({}, safe.loadPlannedAvoidSystems, stranger)

    assert.equal(withStranger.find((row) => row.SystemID === 9).TradeTreaty, 0, 'an owner with no contact row has the neutral treaty value though the column is missing')
    assert.equal(withStranger.find((row) => row.SystemID === 9).TradeTreaty, fullStranger.find((row) => row.SystemID === 9).TradeTreaty)
    assert.equal(withStranger.find((row) => row.SystemID === 4).TradeTreaty, null, 'a contact row present has an unknown treaty')
    assert.equal(detailsOf(withStranger, 'avoidAlien')[9].assumed, false, 'an owner with no contact row is judged as the full schema judges it')
    assert.equal(detailsOf(withStranger, 'avoidAlien')[4].assumed, true)
    ;['ProtectionValue', 'the fleets'].forEach((name) => {
      ;['avoidAlien', 'skipNoAutoRoute'].forEach((key) => same(rows[name], key))
      assert.deepEqual(barredIds(rows[name], 'avoidDanger'), [2, 6], `${name}: a danger the protection cannot be set against is avoided`)
      assert.ok(Object.values(detailsOf(rows[name], 'avoidDanger')).every((found) => found.assumed))
    })
    assert.ok(rows.ProtectionValue.every((row) => row.Protection === null && row.ProtectionShips === null), 'the protection is unknown, not 0')
  })

  add('summary: the haul tile of the Hauling page is unavailable while a setting is on and the systems it reads are not in or the read failed, and shows the plan once they are in and when the settings are cleared', () => {
    const vm = (settings, spare, errors) => instantiate(world.haulingPage, { $store: STORE, database: null, GameID: 1, RaceID: 2, data: { loadErrors: loadErrorsOf(errors), avoidSystems: ROWS, jumpPoints: JUMP_POINTS, colonyStocks: stocks(spare), classes: [], mineralDeliveries: {}, formulaVersion: VERSION, shuttleTechnology: TECH, ...settings } })
    const none = vm(ON(), 'Nobody')
    const ready = vm(ON('avoidDanger'), 'Beta')
    const index = ready.tiles.findIndex((tile, at) => tile.value !== none.tiles[at].value)
    const planned = (instance) => instance.plan.hauls.reduce((total, haul) => total + haul.tonnes, 0)

    assert.ok(index >= 0, 'a tile shows what is to be hauled')
    assert.ok(planned(ready) > 0)
    assert.equal(ready.tiles[index].value, ready.tons(planned(ready)))
    assert.ok(!ready.tiles[index].result, 'a plan has no unavailable mark')

    for (const state of [undefined, 'boom']) {
      const waiting = vm(ON('avoidDanger'), 'Beta', { avoidSystems: state })
      const tile = waiting.tiles[index]

      assert.equal(waiting.avoidPending, true)
      assert.ok(!/\d/.test(tile.value), 'no figure is shown')
      assert.notEqual(tile.value, waiting.tons(0), 'no plan is not an empty plan')
      assert.ok(tile.result && tile.result.status === 'unavailable', 'the tile says why')

      waiting.avoidDanger = false
      assert.equal(waiting.avoidPending, false)
      assert.equal(waiting.tiles[index].value, vm(ON(), 'Beta').tiles[index].value, 'clearing the setting restores the baseline plan')
      assert.ok(!waiting.tiles[index].result)
    }

    ready.avoidDanger = false
    assert.equal(ready.tiles[index].value, vm(ON(), 'Beta').tiles[index].value)
  })

  add('civilian: a shipping line fleet the settings cut off is explained in the alerts the page shows, and with the settings cleared the alert goes', () => {
    const store = { ...STORE, getters: { ...STORE.getters, CivilianShippingLinesActive: true } }
    const line = { ...GROUP([SHIP({ ShippingLine: 1, FleetID: 6, FleetName: 'Liner' })]), FleetID: 6, FleetName: 'Liner', civilian: true }
    const vm = transportVm(ON('avoidAlien'), { destination: 8, store, data: { groups: [line] } })
    const [run] = vm.civilianRuns

    assert.equal(vm.rows.length, 0, 'no military fleet is picked')
    assert.equal(vm.civilianRuns.length, 1)
    assert.equal(run.status, 'noroute')
    assert.ok(run.note.includes('Held') && run.note.includes(label('avoidAlien')), 'the run names the system and the setting')

    const alerts = elementsOf(compiled(world.text.information).ast).filter((element) => element.for === 'problems')

    assert.equal(alerts.length, 1, 'the page lists its problems')
    assert.ok(evaluate(alerts[0].for, vm).some((problem) => problem.text.includes('Liner') && problem.text.includes('Held') && problem.text.includes(label('avoidAlien'))), 'the alerts name the fleet, the system and the setting')

    const clear = transportVm(ON(), { destination: 8, store, data: { groups: [line] } })

    assert.notEqual(clear.civilianRuns[0].status, 'noroute')
    assert.deepEqual(evaluate(alerts[0].for, clear), [])
  })

  return all
}

// ---------- the saves, read-only ----------

const openSave = (file) => new Promise((resolve, reject) => {
  const resolved = path.resolve(root, file)

  if (!fs.existsSync(resolved)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(resolved, sqlite3.OPEN_READONLY, (error) => {
    if (error) {
      reject(error)

      return
    }

    resolve({ query: (sql) => new Promise((resolve, reject) => raw.all(sql, (queryError, rows) => (queryError ? reject(queryError) : resolve([rows])))), close: () => raw.close() })
  })
})

const saveStatements = (world, held) => {
  const all = []
  const { m } = world
  const opened = new Map()
  const loaded = async (save) => {
    if (!opened.has(save.file)) {
      opened.set(save.file, (async () => {
        const database = await openSave(save.file)

        if (!database) {
          return null
        }

        held.push(async () => database.close())

        const ids = { GameID: save.game, RaceID: save.race }
        const raw = async (sql) => (await database.query(sql))[0]
        const rows = await m.safe.loadAvoidSystems(database, ids)
        const jumpPoints = await m.graph.loadJumpPoints(database, ids)
        const colonies = await raw(`select FCT_Population.PopulationID, FCT_Population.PopName, FCT_Population.SystemID, FCT_Population.Capital, FCT_SystemBody.Xcor, FCT_SystemBody.Ycor from FCT_Population inner join FCT_SystemBody on FCT_SystemBody.SystemBodyID = FCT_Population.SystemBodyID where FCT_Population.GameID = ${save.game} and FCT_Population.RaceID = ${save.race} order by FCT_Population.Capital desc, FCT_Population.Population desc`)

        return { raw, rows, jumpPoints, colonies, ids, database }
      })())
    }

    return opened.get(save.file)
  }

  SAVES.forEach((save) => {
    const add = (name, run) => all.push([`save: ${save.label}: ${name}`, run])

    add('the planner\'s schema-aware read gives the Route Finder\'s rows on the save', async () => {
      const data = await loaded(save)

      if (!data) {
        return skip(`${save.file} is not there`)
      }

      const planned = await m.safe.loadPlannedAvoidSystems(data.database, data.ids)
      const byId = (list) => [...list].sort((a, b) => a.SystemID - b.SystemID)

      assert.deepEqual(byId(planned), byId(data.rows))

      return [true, `${planned.length} systems`]
    })

    add('the loader gives one row for each system the race knows, with the ids the settings read', async () => {
      const data = await loaded(save)

      if (!data) {
        return skip(`${save.file} is not there`)
      }

      const [{ count }] = await data.raw(`select count(*) as count from FCT_RaceSysSurvey where GameID = ${save.game} and RaceID = ${save.race}`)

      assert.equal(data.rows.length, count)
      assert.equal(new Set(data.rows.map((row) => row.SystemID)).size, count)
      assert.ok(Object.isFrozen(data.rows))

      return [true, `${count} systems`]
    })

    add('with the settings off a run is the Route Finder\'s search, and with them on every allowed route enters no avoided system, never has fewer jumps than the baseline, and a cut-off run names only avoided systems the race knows', async () => {
      const data = await loaded(save)

      if (!data) {
        return skip(`${save.file} is not there`)
      }

      const origin = data.colonies[0]

      if (!origin) {
        return skip('the race has no colony')
      }

      const known = new Set(data.rows.map((row) => row.SystemID))
      const from = { SystemID: origin.SystemID, Xcor: origin.Xcor, Ycor: origin.Ycor }
      const search = m.graph.searchRoutes(data.jumpPoints, [from], { order: 'jumps' })
      let runs = 0
      let detours = 0
      let blocked = 0

      const targets = [...data.colonies.slice(1, 41).map((colony) => ({ SystemID: colony.SystemID, Xcor: colony.Xcor, Ycor: colony.Ycor })), ...data.rows.map((row) => ({ SystemID: row.SystemID, Xcor: 0, Ycor: 0 }))]

      for (const target of targets) {
        const direct = search.toPlace(target)

        for (const settings of [ON(), ON('avoidDanger'), ON('avoidAlien'), ON('skipNoAutoRoute'), ON('avoidDanger', 'avoidAlien', 'skipNoAutoRoute')]) {
          const avoid = m.safe.avoidRules(data.rows, settings)
          const run = m.safe.planRun({ jumpPoints: data.jumpPoints, origin: from, destination: target, avoid })

          runs++
          assert.equal(Boolean(run.baseline), Boolean(direct), 'the baseline is the search')

          if (direct) {
            assert.equal(run.baseline.jumps, direct.jumps)
            near(run.baseline.km, direct.km)
          }

          if (!avoid.active) {
            assert.equal(run.status, direct ? 'open' : 'unreached')
          } else if (run.route) {
            const barred = m.safe.barredOn(run.route, avoid)

            assert.deepEqual(barred, [], 'the allowed route enters no avoided system')
            assert.ok(run.route.jumps >= run.baseline.jumps)
            detours += run.detour ? 1 : 0
          } else if (direct) {
            blocked++
            assert.equal(run.status, 'blocked')
            assert.ok(run.cutOff.length > 0, 'a blocked run names what cuts it off')
            run.cutOff.forEach((entry) => {
              assert.ok(known.has(entry.SystemID))
              assert.ok(avoid.details[entry.SystemID], 'the system is avoided')
              assert.equal(entry.option, avoid.details[entry.SystemID].option)
            })
          }
        }
      }

      return [true, `${runs} runs, ${detours} detours, ${blocked} cut off`]
    })
  })

  return all
}

// ---------- the faults ----------

// Each planted fault names the source to change, the text to find and its replacement (`find` and `replace`, or `at`, a pattern that matches it once, and `to`, what the match becomes), and the fixture checks, by key, that must fail. Anchors are code, keys and attributes, never wording, so a fault still applies after a benign edit.
const MUTATIONS = [
  { name: 'the settings are never applied to the search', target: 'safe-routes', find: 'canEnter: limited ? (systemId) => transit.canEnter(systemId) && avoid.canEnter(systemId) : transit.canEnter })', replace: 'canEnter: transit.canEnter })', fails: ['detour', 'blocked', 'figures'] },
  { name: 'the destination is never avoided', target: 'safe-routes', find: 'canEnter: limited ? (systemId) => transit.canEnter(systemId) && avoid.canEnter(systemId) : transit.canEnter })', replace: 'canEnter: limited ? (systemId) => transit.canEnter(systemId) && (avoid.canEnter(systemId) || systemId === destination.SystemID) : transit.canEnter })', fails: ['origin'] },
  { name: 'no setting is ever active', target: 'safe-routes', find: 'const active = AVOID_OPTIONS.some((option) => options[option.key])', replace: 'const active = false', fails: ['detour', 'blocked', 'basis'] },
  { name: 'the detour reports the baseline kilometres', target: 'safe-routes', find: 'km: route.km, extraJumps', replace: 'km: baseline.km, extraJumps', fails: ['detour'] },
  { name: 'a system avoided on an assumption counts as observed', target: 'safe-routes', find: "(found.assumed ? 'unknown' : found.option", replace: "(false ? 'unknown' : found.option", fails: ['basis'] },
  { name: 'a flag the player set counts as observed', target: 'safe-routes', find: ": found.option === 'skipNoAutoRoute' ? 'defined' : 'observed')", replace: ": 'observed')", fails: ['basis'] },
  { name: 'the cut-off systems may be reached only back through the allowed region', target: 'safe-routes', find: 'canEnter: (id) => transit.canEnter(id) && !reached.has(id) }', replace: 'canEnter: (id) => transit.canEnter(id) }', fails: ['frontier', 'blocked'] },
  { name: 'a jump point not explored is crossed to name a cut-off system', target: 'safe-routes', find: 'reached.has(jumpPoint.SystemID) && jumpPoint.Explored && far', replace: 'reached.has(jumpPoint.SystemID) && far', fails: ['unobserved'] },
  { name: 'the settings are saved under one key for both pages', target: 'safe-routes', find: '{ key: `${prefix}${capitalised(option.key)}`', replace: '{ key: capitalised(option.key)', fails: ['fields'] },
  { name: 'the settings are not kept per race', target: 'safe-routes', find: "default: false, scope: 'race', valid", replace: 'default: false, valid', fails: ['fields'] },
  { name: 'the avoid rule names the wrong setting for an unknown holder', target: 'route-plan', at: /(ControlKnown === 0\) \{\s*return \{ reason: '[^']*', assumed: true, option: )'avoidAlien'/, to: (match) => `${match[1]}'avoidDanger'`, fails: ['basis'] },
  { name: 'the plan carries avoid fields with the settings off', target: 'haul-plan', find: 'const guarded = Boolean(avoid && avoid.active)', replace: 'const guarded = Boolean(avoid)', fails: ['clear'] },
  { name: 'the plan searches without the settings', target: 'haul-plan', at: /limited \? \{ order: 'km', canEnter: avoid\.canEnter \} : (\{ order: 'km' \})/, to: (match) => match[1], fails: ['hauls'] },
  { name: 'a haul reports the baseline route\'s distance', target: 'haul-plan', at: /km: source\.route\.km, jumps/, to: () => 'km: source.openRoute ? source.openRoute.km : source.route.km, jumps', fails: ['hauls'] },
  { name: 'a colony the settings cut off is never named', target: 'haul-plan', at: /cut: others\.filter\(\(\{ route, openRoute \}\) => !route && openRoute\),/, to: () => 'cut: [],', fails: ['hauls', 'haulcut'] },
  { name: 'a failed read counts as a read', target: 'avoid-routes', find: 'return this.loadErrors.avoidSystems === null ? this.avoidSystems : null', replace: 'return this.avoidSystems', fails: ['pending'] },
  { name: 'a run is planned while the systems are not read', target: 'avoid-routes', find: 'return this.avoidActive && this.avoidRead === null', replace: 'return false', fails: ['pending'] },
  { name: 'Transport times the baseline route', target: 'information', find: 'const route = avoidPending || !safe ? null : safe.route', replace: 'const route = avoidPending || !safe ? null : safe.baseline', fails: ['figures'] },
  { name: 'Transport times a pending run on the baseline', target: 'information', find: '      if (reach.pending) {', replace: '      if (false) {', fails: ['pending'] },
  { name: 'Transport leaves the detour out of the row', target: 'information', find: "detourText: detour ? detourText(detour, this.distance) : '', pathResult", replace: "detourText: '', pathResult", fails: ['figures'] },
  { name: 'Transport does not name the systems of a cut-off run', target: 'information', find: 'return cutOffText(safe.cutOff)', replace: "return 'No route.'", fails: ['figures'] },
  { name: 'Hauling plans without its settings', target: 'hauling', find: 'reserves: this.planReserves, avoid: this.avoid })', replace: 'reserves: this.planReserves })', fails: ['hauling'] },
  { name: 'Hauling plans while the systems are not read', target: 'hauling', find: 'this.avoidPending ? { hauls: [], unmet: [] } : planHauls(', replace: 'planHauls(', fails: ['pending'] },
  { name: 'Hauling leaves the cut-off systems out of the unmet rows', target: 'hauling', at: /cuts\.forEach\(\(source\) => row\.cuts\.set\(source\.colony\.PopulationID, [^\n]*\)\)(?=\n)/, to: () => 'cuts.forEach(() => {})', fails: ['hauling'] },
  { name: 'a haul is searched from the colony that is short', target: 'haul-plan', at: /(route: )searchFrom\(other\.colony, true\)\.toPlace\(placeOf\(colony\)\)/, to: (match) => `${match[1]}searchFrom(colony, true).toPlace(placeOf(other.colony))`, fails: ['direction'] },
  { name: 'a column the save lacks fails the planner\'s read', target: 'safe-routes', at: /survey\.has\(name\) \? (`FCT_RaceSysSurvey\.\$\{name\}`) : 'null'/, to: (match) => match[1], fails: ['schema'] },
  { name: 'a column the save lacks reads as known and clear', target: 'safe-routes', at: /survey\.has\(name\) \? (`FCT_RaceSysSurvey\.\$\{name\}`) : 'null'/, to: (match) => `survey.has(name) ? ${match[1]} : '0'`, fails: ['schema'] },
  { name: 'a missing treaty column makes the treaty of an owner with no contact row unknown', target: 'safe-routes', at: /const treaty = contactKnown \?/, to: () => "const treaty = contactKnown && alien.has('TradeTreaty') ?", fails: ['schema'] },
  { name: 'an owner with no contact row has an unknown treaty', target: 'safe-routes', at: /(then \$\{treatyValue\} else )0( end)/, to: (match) => `${match[1]}null${match[2]}`, fails: ['schema'] },
  { name: 'the pages read the systems with the Route Finder\'s fixed query', target: 'hauling', at: /(import \{[^}]*?)\bloadPlannedAvoidSystems\b([^}]*\} from '\.\.\/utilities\/safe-routes')/, to: (match) => `${match[1]}loadAvoidSystems as loadPlannedAvoidSystems${match[2]}`, fails: ['reads'] },
  { name: 'the haul tile shows an empty plan while the systems are not read', target: 'hauling', at: /this\.avoidPending \? '[^']*' : (this\.tons\(planned\))/, to: (match) => match[1], fails: ['summary'] },
  { name: 'the haul tile drops its unavailable mark while the systems are not read', target: 'hauling', at: /\.\.\.\(this\.avoidPending \? \{ result: unreadResult\(\) \} : \{\}\),\n/, to: () => '', fails: ['summary'] },
  { name: 'the alerts leave out the shipping line fleets', target: 'information', at: /this\.runs(\.filter\(\(row\) => row\.status === 'noroute'\))/, to: (match) => `this.rows${match[1]}`, fails: ['civilian'] },
]

// Edits that change nothing the checks may pin: the words of a label, a hint, a reason and a summary, a comment. Each is located by its structure (a key, an attribute, the test the text belongs to), never by what it holds now.
const BENIGN = [
  { name: 'a setting\'s label and hint reworded', target: 'safe-routes', at: /(\{ key: 'avoidDanger', label: )'(?:[^'\\]|\\.)*'(, hint: )'(?:[^'\\]|\\.)*'/, to: (match) => `${match[1]}'Keep out of danger'${match[2]}'Keeps the route out of dangerous systems.'` },
  { name: 'the unknown basis reworded', target: 'safe-routes', at: /(const BASIS_TEXT = \{[^}]*?unknown: )'[^']*'/, to: (match) => `${match[1]}', avoided because it is not known'` },
  { name: 'a line of comment added', target: 'safe-routes', at: /^const OPEN = Object\.freeze/m, to: (match) => `// Nothing is barred.\n${match[0]}` },
  { name: 'the unknown holder reason reworded', target: 'route-plan', at: /(ControlKnown === 0\) \{\s*return \{ reason: )'[^']*'/, to: (match) => `${match[1]}'Holder not stored in the save'` },
  { name: 'the summary of the first Hauling section reworded', target: 'hauling', at: /(<v-card class="panel" data-summary=)"[^"]*"/, first: true, to: (match) => `${match[1]}"Hauls that cover what the colonies lack, from the nearest colony with stock to spare."` },
  { name: 'the summary of the first Transport section reworded', target: 'information', at: /(<v-card class="panel" data-summary=)"[^"]*"/, first: true, to: (match) => `${match[1]}"The time each fleet takes over the chosen run and what it could carry."` },
]

const MUTANTS = [...MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation })), ...BENIGN.map((edit, index) => ({ id: `benign:${index}`, benign: true, ...edit }))]
// The same planted faults on the source with every benign edit applied.
const COMPOSED = MUTATIONS.map((mutation, index) => ({ id: `composed:${index}`, ...mutation }))

// ---------- the parts ----------

const keyOf = (name) => name.slice(0, name.indexOf(':'))

const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      const given = await test()

      result = given === undefined ? true : given
    } catch (error) {
      result = `${error.name === 'AssertionError' ? '' : 'threw '}${String(error.message).split('\n').slice(0, 3).join(' | ').slice(0, 400)}`
    }

    results.push([name, result])
  }

  return results
}

const checkHead = async () => {
  const held = []
  const world = await worldOf()

  console.log('\nAvoid settings on Transport and Hauling routes, on a fixture and the saves')

  try {
    for (const [name, result] of await runStatements([...fixtures(world), ...saveStatements(world, held)])) {
      if (Array.isArray(result)) {
        check(name, result[0], result[1])
      } else {
        check(name, result)
      }
    }
  } finally {
    for (const close of held) {
      await close()
    }
  }
}

const checkMutant = async (mutant, composed = false) => {
  const began = Date.now()
  const label = mutant.benign ? 'benign edit kept' : composed ? 'mutation caught on the stacked benign edits' : 'mutation caught'
  let world

  try {
    world = await worldOf(composed ? [...BENIGN, mutant] : [mutant])
  } catch (error) {
    check(`${label}: ${mutant.name}`, `${/does not apply|does not parse/.test(error.message) ? 'invalid mutant' : 'does not load'}: ${error.message}`)

    return
  }

  const statements = fixtures(world)

  if (mutant.benign) {
    const results = await runStatements(statements)
    const broken = results.filter(([, result]) => result !== true)

    check(`${label}: ${mutant.name}`, broken.length ? `these checks failed: ${broken.map(([name]) => keyOf(name)).join(', ')}` : true, `${results.length} checks green, ${((Date.now() - began) / 1000).toFixed(1)} s`)

    return
  }

  const absent = mutant.fails.filter((key) => !statements.some(([name]) => keyOf(name) === key))
  const results = await runStatements(statements, mutant.fails)
  const missed = mutant.fails.filter((key) => {
    const ran = results.filter(([name]) => keyOf(name) === key)

    return ran.length > 0 && !ran.some(([, result]) => result !== true)
  })

  check(`${label}: ${mutant.name}`, absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

// The benign edits are independent of one another: each is located by structure, so it still applies to a source another has already changed, and the source with every one of them applied is still green.
const checkStacked = async () => {
  const began = Date.now()
  const conflicts = []

  for (const first of BENIGN) {
    let after

    try {
      after = applied({ ...ORIGINALS }, first)
    } catch (error) {
      conflicts.push(`${first.name}: ${error.message}`)

      continue
    }

    for (const second of BENIGN) {
      try {
        applied(after, second)
      } catch (error) {
        conflicts.push(`${second.name} after ${first.name}: ${error.message}`)
      }
    }
  }

  check('benign edits: each still applies to a source another has changed', conflicts.length ? conflicts.slice(0, 4).join(' | ') : true, `${BENIGN.length * BENIGN.length} pairs`)

  let results

  try {
    results = await runStatements(fixtures(await worldOf(BENIGN)))
  } catch (error) {
    check('benign edits: all of them together keep every fixture check green', `does not load: ${error.message}`)

    return
  }

  const broken = results.filter(([, result]) => result !== true)

  check('benign edits: all of them together keep every fixture check green', broken.length ? `these checks failed: ${broken.map(([name]) => keyOf(name)).join(', ')}` : true, `${results.length} checks green, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true, saves: [] }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--save') {
      options.saves.push({ label: `save ${options.saves.length + 1}`, file: argv[++index], game: Number(argv[++index]), race: Number(argv[++index]) })
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  if (options.part !== null) {
    const mutant = MUTANTS.find(({ id }) => id === options.part)

    if (options.part === 'head') {
      await checkHead()
    } else if (mutant) {
      await checkMutant(mutant)
    } else if (COMPOSED.some(({ id }) => id === options.part)) {
      await checkMutant(COMPOSED.find(({ id }) => id === options.part), true)
    } else if (options.part === 'stacked') {
      await checkStacked()
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  if (options.saves.length) {
    process.env.SAFE_ROUTES_SAVES = JSON.stringify(options.saves)
  }

  const wanted = options.mutations ? MUTANTS : []
  const stacked = options.mutations ? ['stacked'] : []
  const composed = options.mutations ? COMPOSED : []
  const sections = await runSections(__filename, [{ args: ['--part', 'head'], weight: 30 }, ...[...wanted, ...composed].map(({ id }) => ({ args: ['--part', id], weight: 3 })), ...stacked.map((id) => ({ args: ['--part', id], weight: 5 }))])
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
  }

  printed()

  if (wanted.length) {
    console.log('\nMutations: each must fail the checks it names; benign edits must leave every fixture check green')
    wanted.forEach(printed)
  }

  if (composed.length) {
    console.log('\nPlanted faults on the source with every benign edit applied: each must still apply once and fail the checks it names')
    composed.forEach(printed)
  }

  if (stacked.length) {
    console.log('\nBenign edits stacked: each still applies after any other, and all of them together leave every fixture check green')
    stacked.forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
