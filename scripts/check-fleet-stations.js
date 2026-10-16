/*
  Checks the intended station and preferred supply base of a fleet, kept as local notes beside where the fleet is and the orders saved for it (src/renderer/utilities/fleet-stations.js, src/renderer/mixins/fleet-stations.js, src/renderer/components/fleets/FleetStations.vue and their mount in src/renderer/pages/logistics.vue).

  bun scripts/check-fleet-stations.js [--no-mutations] [--no-saves]

  Everything runs on in-memory scenario stores, the real scenario repository and a fake save that records the SQL it is sent. Groups:
  - orbit: a fleet in the orbit of the station's body is on station by that identity, whatever coordinates the body has now; a fleet at the body's old coordinates and in no orbit is off; a fleet at the same position is on station within the distance the game takes for one point and is not followed when the body moves; a waypoint tied to a body is matched by the body's orbit, an untied one by position; a fleet in another system is off; what is not known is not compared;
  - reuse: a deleted fleet leaves an archived note and no location, an ID given to another fleet (another creation time) is under review, never takes the note and is compared with nothing, a fleet the save does not date is held only by the player's confirmation of that very fleet (name and ship classes), a waypoint or colony under the same ID reads the same way, confirming re-pins only a reference under review, and a fleet ID has one note;
  - stale: a deleted station or base leaves the note stale with the name and system it had, and no location; a rename keeps the link;
  - unread: a kind of object the save could not give reads not checked, never gone or stale;
  - separation: the note, the place of the fleet, its location against the note and its saved orders are four apart things of a row, and a note is never an order;
  - orders: the saved orders are read as saved, and the last of them is said to end at the station only when it does;
  - checklist: the manual steps for a fleet, with no wording and no link;
  - marks: each comparison and distance has a provenance result, unavailable where nothing is known;
  - isolation: another race, branch or campaign never lists a note, a note shared with the campaign lists on every branch;
  - write: a note is kept, edited over its revision, kept for a fleet once, refused for objects picked elsewhere, and deleted;
  - payload: what a note may hold;
  - loaders: every statement is a select, a column the save leaves null stays null, a kind that cannot be read is named, a batch that fails fails the read;
  - component: the panel's template, its summary in every state, its three regions apart, a mark on every figure, its states while a read is out, its lists, its form and its writes;
  - page: the mount, the view, the tracked reads and their labels;
  - optional: the reads behind the panel hold nothing back: the page is ready while they are in flight or failed, and the panel shows the progress or the failure, with a Retry that reads again only the failed ones.

  The saves (saves/AuroraDB_271_skoormit_saved.db, game 138, race 785, and AuroraDB.db, game 140, race 784, read-only; a save that is not there is skipped) give the real loaders, compared with raw counts, and the orbit rule on every fleet in orbit.

  Each planted fault must fail a check that needs no save and that it names. Each benign edit (wording, whitespace, the order of attributes or of a list) must leave every check that needs no save green, alone, stacked, and under every planted fault. Exit code 1 when a check fails.
*/
const fs = require('fs')
const path = require('path')
const acorn = require('acorn')
const sqlite3 = require('sqlite3')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { endSection, runSections, printSection } = require('./lib/check-sections')

const root = path.resolve(__dirname, '..')
const FILES = {
  utility: path.join(root, 'src', 'renderer', 'utilities', 'fleet-stations.js'),
  mixin: path.join(root, 'src', 'renderer', 'mixins', 'fleet-stations.js'),
  component: path.join(root, 'src', 'renderer', 'components', 'fleets', 'FleetStations.vue'),
  page: path.join(root, 'src', 'renderer', 'pages', 'logistics.vue'),
}
const U = 'utility'
const X = 'mixin'
const V = 'component'
const P = 'page'
const NAMES = ['fleet-stations', 'scenario-records', 'provenance', 'history-milestones', 'economy-notes', 'place-data']
const SAVES = [
  { file: 'saves/AuroraDB_271_skoormit_saved.db', game: 138, race: 785 },
  { file: 'AuroraDB.db', game: 140, race: 784 },
]

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  electron: 'export const ipcRenderer = { invoke: () => Promise.resolve(null) }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}
const THEME_STUB = 'export const chartTheme = () => ({ categorical: [], ink: "", inkMuted: "", primary: "" }); export const withAlpha = (color) => color; export const patternImage = () => null; export const seriesIdentity = () => null'
// The persisted view stood in by a module that records the fields a page declares, for a check of the view the page keeps.
const RECORDER = 'export const oneOf = (values) => (value) => values.includes(value); export const tableView = (key, defaults) => ({ key, default: defaults, table: true }); export default (fields) => { globalThis.__persistedFields = fields; return { data: () => Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.default])) } }'
const STORE = { getters: { config: { get: () => 'Tick' } }, state: {} }
const CAMPAIGN = { campaignId: 'c1', branchId: 'b1' }
const PAGE_STORE = { getters: { 'capabilities/blockedBonuses': new Set(), 'history/campaign': CAMPAIGN, GameTime: 100000 }, state: { RaceNPR: false, history: { revision: 0 } }, dispatch: async () => {} }

let failures = 0
let checks = 0

const check = (name, result, detail = '') => {
  const ok = result === true

  checks++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `  [${typeof result === 'string' ? result : 'false'}]`}`)
}

const SHORT_LIMIT = Number(process.env.SHORT_LIMIT) || 300
const DROPPED = new Set(['rule', 'assumptions'])

const short = (value) => {
  const text = JSON.stringify(value, (key, item) => (DROPPED.has(key) ? undefined : item))

  return text === undefined ? 'undefined' : text.length > SHORT_LIMIT ? `${text.slice(0, SHORT_LIMIT)}…` : text
}

// True, or a text with what differed (the bounded assertion's own, shortened).
const same = (actual, expected) => {
  try {
    assert.deepEqual(actual, expected)

    return true
  } catch (error) {
    return `${short(actual)} != ${short(expected)}`
  }
}

const near = (actual, expected, tolerance = 1e-6) => typeof actual === 'number' && Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected))

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const descriptorOf = (source) => {
  const compiler = require('vue/compiler-sfc')
  const parsed = compiler.parse({ source })

  return parsed.descriptor || parsed
}

const compiled = (source) => require('vue/compiler-sfc').compileTemplate({ source: descriptorOf(source).template.content, filename: 'component.vue', id: 'component' })

const templateErrors = (source) => compiled(source).errors.map(String)

const templateAst = (source) => compiled(source).ast

// Every element of a compiled template in document order, the branches of a v-if chain and the scoped slots included.
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

const staticTextOf = (ast) => {
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

const evaluate = (expression, instance) => require('vm').runInNewContext(`with (scope) { (${expression}) }`, { scope: instance })

// What an element binds: the props by name and the handlers by event, as the expressions written.
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

// The keys of an object literal a script declares at its top level (`const NAME = { ... }`, exported or not): the names of its properties, and `...name` for a spread.
const objectKeys = (script, name) => {
  const ast = acorn.parse(script, { ecmaVersion: 'latest', sourceType: 'module' })

  for (const node of ast.body) {
    const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node

    if (declaration && declaration.type === 'VariableDeclaration') {
      for (const one of declaration.declarations) {
        if (one.id.name === name && one.init && one.init.type === 'ObjectExpression') {
          return one.init.properties.map((property) => (property.type === 'SpreadElement' ? `...${property.argument.name}` : property.key.name || property.key.value))
        }
      }
    }
  }

  return null
}

const scriptOf = (source) => descriptorOf(source).script.content

const PRONOUNS = /\b(I|me|my|mine|you|your|we|our)\b/i
const GAME = 1
const RACE = 7

// ---------- the fixtures ----------

// The stores of one installation: each a JSON value read and written whole, as electron-store's `.store` is, with the store client's whole-file `update`.
const memory = () => {
  const files = new Map()
  const registry = { value: {} }
  const store = (name) => ({
    get store () {
      return clone(files.get(name)) || {}
    },
    set store (value) {
      files.set(name, clone(value))
    },
    update (change) {
      for (;;) {
        const base = JSON.stringify(this.store)
        const next = change(JSON.parse(base))

        if (JSON.stringify(this.store) === base) {
          this.store = next

          return next
        }
      }
    },
  })

  return { files, registry, storage: { open: (campaignId) => store(`campaign-${campaignId}`), registry: () => clone(registry.value), writable: () => Promise.resolve(true) } }
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const world = (m, inst = memory()) => {
  const registry = m.records.createAdapterRegistry()
  let clock = 1000
  let ids = 0

  m.fs.registerFleetStations(registry.register)

  const make = (extra = {}) => m.records.createRepository({ storage: inst.storage, adapters: registry, newId: () => uuid(++ids), now: () => ++clock, ...extra })

  return { inst, registry, make, repo: make() }
}

const scope = (branchId = 'b1', RaceID = RACE, campaignId = 'c1', gameTime = 100000) => ({ campaignId, RaceID, branchId, gameTime })

// The branches of the campaign c1 as the registry holds them: b2 left b1 at game time 1000, b3 at 3000.
const TREE = { b1: { parent: null, t: null }, b2: { parent: 'b1', t: 1000 }, b3: { parent: 'b1', t: 3000 }, b4: { parent: 'b1', t: null } }

// ---------- a fake save: the tables the queries of the panel read ----------

const system = (id, name, discovered) => ({ id, name, discovered })

const body = (id, name, systemId, x, y, extra = {}) => ({ id, name, systemId, x, y, planet: 1, orbit: 0, bodyClass: 1, bodyType: 2, ...extra })

const colony = (id, name, systemId, bodyId, speciesId = 7) => ({ id, name, systemId, bodyId, speciesId })

const fleet = (id, name, created, systemId, extra = {}) => ({ id, name, created, systemId, orbit: 0, assigned: 0, x: 0, y: 0, classes: [5], ships: 1, ...extra })

const waypoint = (id, systemId, extra = {}) => ({ id, systemId, orbit: 0, created: 600, x: 0, y: 0, number: id, type: 1, name: 'Marker', ...extra })

const order = (id, fleetId, text, destinationType, destinationId, extra = {}) => ({ id, fleetId, order: id, text, destinationType, destinationId, minDistance: 0, arrived: 0, ...extra })

const SAVE = () => ({
  systems: [system(1, 'Sol', 500), system(2, 'Alpha Centauri', 2000)],
  bodies: [body(100, 'Earth', 1, 1000, 2000), body(101, 'Mars', 1, 5000, 0), body(200, 'Proxima b', 2, 0, 0)],
  colonies: [colony(10, 'Earth Prime', 1, 100), colony(11, 'Proxima Base', 2, 200)],
  fleets: [fleet(30, '1st Fleet', 400, 1, { orbit: 100, x: 1000, y: 2000, classes: [5, 6] }), fleet(31, '2nd Fleet', 2500, 2, { orbit: 0, x: 50, y: 60, classes: [7] })],
  waypoints: [waypoint(60, 1, { orbit: 100, x: 1000, y: 2000, number: 1, created: 600 }), waypoint(61, 1, { orbit: 0, x: 3000, y: 3000, number: 2, created: 700 })],
  orders: [order(1, 30, 'ORDER-MARKER move to Earth', 2, 100)],
})

const edited = (save, change) => {
  const copy = clone(save)

  change(copy)

  return copy
}

const found = (list, id) => list.find((row) => row.id === id)

// `failing` names a fragment of SQL that makes the fake throw, as a save that lacks a table does. The fake answers by the table the SQL names, honours the condition that hides a waypoint marked for deletion, and records everything it is sent.
const fakeSave = (save, { failing = [] } = {}) => {
  const sent = []
  const named = (id) => {
    const one = found(save.systems, id)

    return one ? one.name : null
  }

  return {
    sent,
    query: async (sql, options = {}) => {
      sent.push({ sql, replacements: options.replacements })

      const failed = failing.find((fragment) => sql.includes(fragment))

      if (failed) {
        throw new Error(`no such table: ${failed}`)
      }

      const bodyRow = (row) => ({ SystemBodyID: row.id, SystemID: row.systemId, BodyClass: row.bodyClass, BodyTypeID: row.bodyType, PlanetNumber: row.planet, OrbitNumber: row.orbit, Xcor: row.x, Ycor: row.y, Component: 1, SystemBodyName: row.name, SystemName: named(row.systemId), DiscoveredTime: found(save.systems, row.systemId).discovered })

      if (sql.startsWith('select FCT_SystemBody.')) {
        const wanted = /FCT_SystemBody\.SystemBodyID in \(([\d, ]+)\)/.exec(sql)
        const ids = wanted ? wanted[1].split(',').map((part) => Number(part.trim())) : null
        const only = sql.includes(':SystemID') ? options.replacements.SystemID : null

        return [save.bodies.filter((row) => (ids ? ids.includes(row.id) : row.systemId === only)).filter((row) => found(save.systems, row.systemId)).map(bodyRow)]
      }

      if (sql.includes('from FCT_Population')) {
        return [save.colonies.map((row) => ({ PopulationID: row.id, PopName: row.name, SpeciesID: row.speciesId, SystemID: row.systemId, SystemBodyID: row.bodyId, SystemName: named(row.systemId) }))]
      }

      if (sql.startsWith('select FCT_Fleet.FleetID')) {
        return [save.fleets.map((row) => {
          const orbiting = row.orbit > 0 ? found(save.bodies, row.orbit) : null

          return { FleetID: row.id, FleetName: row.name, SystemID: row.systemId, SystemName: named(row.systemId), OrbitBodyID: row.orbit, AssignedPopulationID: row.assigned, Xcor: row.x, Ycor: row.y, CreatedTime: row.created, BodyClass: orbiting ? orbiting.bodyClass : null, PlanetNumber: orbiting ? orbiting.planet : null, OrbitNumber: orbiting ? orbiting.orbit : null, SystemBodyName: orbiting ? orbiting.name : null, Component: orbiting ? 1 : null, Classes: row.classes === null ? null : row.classes.join(','), Ships: row.ships }
        })]
      }

      if (sql.startsWith('select FCT_Waypoint.WaypointID')) {
        const hidden = /FCT_Waypoint\.WaypointType != (\d+)/.exec(sql)

        return [save.waypoints.filter((row) => !hidden || row.type !== Number(hidden[1])).map((row) => ({ WaypointID: row.id, SystemID: row.systemId, SystemName: named(row.systemId), OrbitBodyID: row.orbit, CreationTime: row.created, Xcor: row.x, Ycor: row.y, Number: row.number, WaypointType: row.type, Name: row.name }))]
      }

      if (sql.startsWith('select FCT_MoveOrders.MoveOrderID')) {
        return [save.orders.map((row) => ({ MoveOrderID: row.id, FleetID: row.fleetId, MoveOrder: row.order, Description: row.text, DestinationType: row.destinationType, DestinationID: row.destinationId, MinDistance: row.minDistance, Arrived: row.arrived }))]
      }

      if (sql.startsWith('select FCT_RaceSysSurvey.SystemID')) {
        return [save.systems.map((row) => ({ SystemID: row.id, Name: row.name, DiscoveredTime: row.discovered, SystemNumber: row.id, Stars: 1 }))]
      }

      throw new Error(`the fake save does not answer ${sql}`)
    },
  }
}

// ---------- the in-memory scenario ----------

const KEY_NOTE = 'NOTE-MARKER'

// The objects of an open save as the panel hands them to the notes: the objects and the bodies the notes name, with the campaign and branch the save is open on.
const open = async (m, save, where = scope(), { bodyIds = null, branches = TREE, failing = [] } = {}) => {
  const database = fakeSave(save, { failing })
  const objects = await m.fs.loadStationObjects(database, { GameID: GAME, RaceID: where.RaceID })
  const bodies = await m.fs.loadStationBodies(database, { GameID: GAME, RaceID: where.RaceID, bodyIds: bodyIds || save.bodies.map((row) => row.id) })
  const merged = m.fs.withBodies(objects, bodies)

  return { ...merged, campaignId: where.campaignId, branchId: where.branchId, branches, database }
}

const aim = (context, type, id) => ({ type, row: context.objects[type].get(id) })

const keep = (m, w, where, context, { fleet: fleetId = 30, station = ['body', 100], base = ['colony', 10], note = KEY_NOTE, ...extra } = {}) => m.fs.saveStation(w.repo, where, { fleet: aim(context, 'fleet', fleetId), station: station ? aim(context, station[0], station[1]) : null, base: base ? aim(context, base[0], base[1]) : null, note, context, ...extra })

const kept = async (m, w, where, context, options = {}) => {
  const outcome = await keep(m, w, where, context, options)

  assert.equal(outcome.ok, true, outcome.message)

  return outcome.record
}

// The fleets of a save with their notes as the open branch reads them in a save: `{ ctx, read, shown }`.
const readOn = async (m, w, save, where = scope(), options = {}) => {
  const ctx = await open(m, save, where, options)
  const orders = await m.fs.loadFleetOrders(ctx.database, { GameID: GAME, RaceID: where.RaceID })
  const read = m.fs.readStations(w.repo, where, ctx)
  const shown = m.fs.stationRows({ fleets: ctx.objects.fleet, entries: read.entries, orders })

  return { ctx, read, shown, orders }
}

const rowOf = (shown, id) => shown.rows.find((row) => row.key === id)

// The fleet and the station as rows of the loaders, for the comparison alone.
const fleetRow = (extra = {}) => ({ type: 'fleet', id: 30, name: 'F', systemId: 1, orbitBodyId: 0, assignedPopulationId: 0, x: 0, y: 0, classes: [5], ...extra })
const bodyRow = (extra = {}) => ({ type: 'body', id: 100, name: 'Earth', systemId: 1, x: 1000, y: 2000, ...extra })
const waypointRow = (extra = {}) => ({ type: 'waypoint', id: 60, name: 'Marker', systemId: 1, orbitBodyId: 0, x: 3000, y: 3000, ...extra })

// ---------- the utility ----------

const pure = (ctx) => {
  const { m } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const cmp = m.fs.compareStation

  // ---- orbit ----
  add('orbit: a fleet in the orbit of the station body is on station by that identity though its coordinates are not the body\'s', () => {
    const result = cmp(fleetRow({ orbitBodyId: 100, x: 7, y: 7 }), bodyRow())

    return result.state === 'on' && result.basis === 'orbit' && result.movement === 'follows' ? true : short(result)
  })
  add('orbit: a body that moved leaves the fleet in its orbit on station, and a fleet left at the old coordinates in no orbit off station', async () => {
    const w = world(m)
    const save = SAVE()
    const first = await open(m, save)

    await kept(m, w, scope(), first)

    const moved = edited(save, (copy) => {
      found(copy.bodies, 100).x = 1500
      found(copy.bodies, 100).y = 2500
      found(copy.fleets, 30).x = 1500
      found(copy.fleets, 30).y = 2500
    })
    const { read } = await readOn(m, w, moved)
    const left = edited(moved, (copy) => {
      found(copy.fleets, 30).orbit = 0
      found(copy.fleets, 30).x = 1000
      found(copy.fleets, 30).y = 2000
    })
    const { read: stale } = await readOn(m, w, left)

    return read.entries[0].location.station.state === 'on' && read.entries[0].location.station.basis === 'orbit' && stale.entries[0].location.station.state === 'off' && stale.entries[0].location.station.where === 'open-space' ? true : short([read.entries[0].location.station, stale.entries[0].location.station])
  })
  add('orbit: the orbit of another body is off station, in another orbit', () => {
    const result = cmp(fleetRow({ orbitBodyId: 101, x: 5000, y: 0 }), bodyRow())

    return result.state === 'off' && result.where === 'other-orbit' && result.basis === null ? true : short(result)
  })
  add('orbit: at the body\'s position and in no orbit a fleet is on station within the distance the game takes for one point, and the boundary is off', () => {
    const inside = cmp(fleetRow({ x: 1000.999, y: 2000 }), bodyRow())
    const edge = cmp(fleetRow({ x: 1001, y: 2000 }), bodyRow())
    const exact = cmp(fleetRow({ x: 1000, y: 2000 }), bodyRow())

    return inside.state === 'on' && inside.basis === 'position' && edge.state === 'off' && exact.state === 'on' && near(edge.distance.value, 1) ? true : short([inside, edge, exact])
  })
  add('orbit: a fleet that is at a body by position only is left behind when the body moves, and one at a point tied to no body is at a fixed point', () => {
    const atBody = cmp(fleetRow({ x: 1000, y: 2000 }), bodyRow())
    const atPoint = cmp(fleetRow({ x: 3000, y: 3000 }), waypointRow())
    const elsewhere = cmp(fleetRow({ orbitBodyId: 101, x: 1000, y: 2000 }), bodyRow())

    return atBody.state === 'on' && atBody.movement === 'left-behind' && elsewhere.movement === 'left-behind' && atPoint.state === 'on' && atPoint.basis === 'position' && atPoint.movement === 'fixed' ? true : short([atBody.movement, atPoint.movement, elsewhere.movement])
  })
  add('orbit: a position that matches while the orbit of the fleet or the body a waypoint is tied to is null is on station, with neither a fleet left behind nor a fixed point said', () => {
    const noOrbit = cmp(fleetRow({ orbitBodyId: null, x: 1000, y: 2000 }), bodyRow())
    const noOrbitAtTied = cmp(fleetRow({ orbitBodyId: null, x: 3000, y: 3000 }), waypointRow({ orbitBodyId: 100 }))
    const noTie = cmp(fleetRow({ orbitBodyId: 0, x: 3000, y: 3000 }), waypointRow({ orbitBodyId: null }))
    const neither = cmp(fleetRow({ orbitBodyId: null, x: 3000, y: 3000 }), waypointRow({ orbitBodyId: null }))
    const fixedWhateverTheFleet = cmp(fleetRow({ orbitBodyId: null, x: 3000, y: 3000 }), waypointRow({ orbitBodyId: 0 }))

    return [noOrbit, noOrbitAtTied, noTie, neither].every((result) => result.state === 'on' && result.basis === 'position' && result.movement === 'unknown') && fixedWhateverTheFleet.movement === 'fixed' ? true : short([noOrbit.movement, noOrbitAtTied.movement, noTie.movement, neither.movement, fixedWhateverTheFleet.movement])
  })
  add('orbit: a waypoint tied to a body is matched by the body\'s orbit and an untied waypoint by position', () => {
    const tied = cmp(fleetRow({ orbitBodyId: 100, x: 9, y: 9 }), waypointRow({ orbitBodyId: 100, x: 1000, y: 2000 }))
    const untied = cmp(fleetRow({ orbitBodyId: 100, x: 9, y: 9 }), waypointRow({ orbitBodyId: 0 }))
    const samePosition = cmp(fleetRow({ x: 3000, y: 3000 }), waypointRow({ orbitBodyId: 0 }))

    return tied.state === 'on' && tied.basis === 'orbit' && untied.state === 'off' && samePosition.state === 'on' && samePosition.basis === 'position' ? true : short([tied, untied, samePosition])
  })
  add('orbit: a fleet in another system is off station and no distance is given between two systems', () => {
    const result = cmp(fleetRow({ systemId: 2, x: 1000, y: 2000 }), bodyRow())

    return result.state === 'off' && result.where === 'other-system' && result.distance === null ? true : short(result)
  })
  add('orbit: a system, an orbit or a position the save does not give is not compared as off station', () => {
    const noSystem = cmp(fleetRow({ systemId: null }), bodyRow())
    const nothing = cmp(fleetRow({ orbitBodyId: null, x: null, y: null }), bodyRow())

    return noSystem.state === 'unknown' && nothing.state === 'unknown' && noSystem.result.status === 'unavailable' ? true : short([noSystem, nothing])
  })
  add('orbit: a fleet is at its supply base in the orbit of the colony\'s body or assigned to the colony, and elsewhere off', () => {
    const colonyRow = { type: 'colony', id: 10, bodyId: 100 }
    const orbiting = m.fs.compareBase(fleetRow({ orbitBodyId: 100 }), colonyRow)
    const assigned = m.fs.compareBase(fleetRow({ orbitBodyId: 0, assignedPopulationId: 10 }), colonyRow)
    const elsewhere = m.fs.compareBase(fleetRow({ orbitBodyId: 101 }), colonyRow)
    const unknown = m.fs.compareBase(fleetRow({ orbitBodyId: null, assignedPopulationId: null }), colonyRow)

    return orbiting.state === 'on' && assigned.state === 'on' && elsewhere.state === 'off' && elsewhere.where === 'other-orbit' && unknown.state === 'unknown' ? true : short([orbiting.state, assigned.state, elsewhere, unknown.state])
  })

  // ---- reuse ----
  add('reuse: a deleted fleet leaves an archived note with its names and no location, and no row of its own', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const gone = edited(save, (copy) => { copy.fleets = copy.fleets.filter((row) => row.id !== 30) })
    const { shown } = await readOn(m, w, gone)
    const [entry] = shown.archived

    return shown.archived.length === 1 && shown.review.length === 0 && entry.fleetState === 'gone' && entry.intent.fleet.name === '1st Fleet' && entry.intent.station.name === 'Earth' && entry.location.station.state === 'unknown' && entry.location.base.state === 'unknown' && !rowOf(shown, 30) && shown.rows.every((row) => row.entry === null) ? true : short(shown.archived)
  })
  add('reuse: a fleet ID given to another fleet (another creation time) is under review, takes no note and is compared with nothing, even at the station', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const reissued = edited(save, (copy) => {
      Object.assign(found(copy.fleets, 30), { name: '9th Fleet', created: 9000 })
    })
    const { shown } = await readOn(m, w, reissued)
    const row = rowOf(shown, 30)
    const [entry] = shown.review

    return row && row.entry === null && row.intent === null && row.location === null && shown.review.length === 1 && shown.archived.length === 0 && entry.fleetState === 'review' && entry.intent.fleet.verdict.basis === 'reused' && entry.location.station.state === 'unknown' && entry.location.base.state === 'unknown' && entry.intent.fleet.row.name === '9th Fleet' ? true : short([row && row.entry, shown.review.length, entry && entry.intent.fleet.verdict])
  })
  add('reuse: a fleet the save does not date is held by the player\'s confirmation of that very fleet, by name and ship classes, and by nothing else', async () => {
    const w = world(m)
    const save = edited(SAVE(), (copy) => { found(copy.fleets, 30).created = null })

    await kept(m, w, scope(), await open(m, save))

    const states = {}
    const probe = async (name, change) => {
      const { shown } = await readOn(m, w, edited(save, change))

      states[name] = shown.review.length ? shown.review[0].intent.fleet.verdict : { state: rowOf(shown, 30) && rowOf(shown, 30).entry ? 'held' : 'none' }
    }

    await probe('same', () => {})
    await probe('renamed', (copy) => { found(copy.fleets, 30).name = 'Another' })
    await probe('classes', (copy) => { found(copy.fleets, 30).classes = [99] })
    await probe('both', (copy) => { Object.assign(found(copy.fleets, 30), { name: 'Another', classes: [99] }) })

    return states.same.state === 'held' && states.renamed.state === 'review' && states.renamed.basis === 'unwitnessed' && states.classes.state === 'review' && states.both.state === 'review' ? true : short(states)
  })
  add('reuse: a note on a fleet the save dates is held by the save\'s own evidence, a note on one it does not by the player\'s confirmation', async () => {
    const w = world(m)
    const dated = SAVE()
    const undated = edited(SAVE(), (copy) => { found(copy.fleets, 30).created = null })
    const first = await readOn(m, w, dated).then(async ({ ctx }) => { await kept(m, w, scope(), ctx); return readOn(m, w, dated) })
    const w2 = world(m)

    await kept(m, w2, scope(), await open(m, undated))

    const second = await readOn(m, w2, undated)

    return first.read.entries[0].intent.fleet.verdict.basis === 'evidence' && second.read.entries[0].intent.fleet.verdict.basis === 'confirmed' ? true : short([first.read.entries[0].intent.fleet.verdict, second.read.entries[0].intent.fleet.verdict])
  })
  add('reuse: a note is never moved to another fleet by its name or its place', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const renumbered = edited(save, (copy) => {
      copy.fleets = copy.fleets.filter((row) => row.id !== 30)
      copy.fleets.push(fleet(77, '1st Fleet', 400, 1, { orbit: 100, x: 1000, y: 2000, classes: [5, 6] }))
    })
    const { shown } = await readOn(m, w, renumbered)

    return shown.archived.length === 1 && rowOf(shown, 77).entry === null && rowOf(shown, 77).location === null ? true : short([shown.archived.length, rowOf(shown, 77)])
  })
  add('reuse: confirming a fleet under review attaches the note to the fleet that holds the ID now, and compares with it from then on', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const reissued = edited(save, (copy) => { Object.assign(found(copy.fleets, 30), { name: '9th Fleet', created: 9000 }) })
    const before = await readOn(m, w, reissued)
    const outcome = await m.fs.confirmTarget(w.repo, scope(), { entry: before.shown.review[0], role: 'fleet', context: before.ctx })
    const after = await readOn(m, w, reissued)
    const row = rowOf(after.shown, 30)

    return outcome.ok === true && after.shown.review.length === 0 && row.entry !== null && row.entry.fleetState === 'held' && row.location.station.state === 'on' && row.entry.intent.fleet.name === '9th Fleet' ? true : short([outcome, after.shown.review.length, row.entry && row.entry.fleetState])
  })
  add('reuse: confirming is refused for a reference that is held, gone or not read, and writes nothing', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const held = await readOn(m, w, save)
    const goneSave = edited(save, (copy) => { copy.bodies = copy.bodies.filter((row) => row.id !== 100) })
    const gone = await readOn(m, w, goneSave)
    const unread = await readOn(m, w, save, scope(), { failing: ['from FCT_Population'] })
    const refusals = []

    refusals.push(await m.fs.confirmTarget(w.repo, scope(), { entry: held.read.entries[0], role: 'station', context: held.ctx }))
    refusals.push(await m.fs.confirmTarget(w.repo, scope(), { entry: gone.read.entries[0], role: 'station', context: gone.ctx }))
    refusals.push(await m.fs.confirmTarget(w.repo, scope(), { entry: unread.read.entries[0], role: 'base', context: unread.ctx }))

    return refusals.every((outcome) => outcome.ok === false && outcome.code === 'not-in-review') && w.repo.list(scope(), { kind: m.fs.STATION_KIND })[0].record.revision === 1 ? true : short(refusals)
  })
  add('reuse: a fleet ID has one note: another note for it is refused, also while the note waits for review', async () => {
    const w = world(m)
    const save = SAVE()
    const context = await open(m, save)

    await kept(m, w, scope(), context)

    const again = await keep(m, w, scope(), context)
    const reissued = edited(save, (copy) => { Object.assign(found(copy.fleets, 30), { name: '9th Fleet', created: 9000 }) })
    const second = await open(m, reissued)
    const over = await keep(m, w, scope(), second)

    return again.ok === false && again.code === 'exists' && over.ok === false && over.code === 'exists' && w.repo.list(scope(), { kind: m.fs.STATION_KIND }).length === 1 ? true : short([again, over])
  })
  add('reuse: a waypoint cleared and made again under the same ID (another number in the system) is under review and compared with nothing', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save), { station: ['waypoint', 61], base: null })

    const remade = edited(save, (copy) => { Object.assign(found(copy.waypoints, 61), { created: 9999, number: 3 }) })
    const { shown } = await readOn(m, w, remade)
    const entry = shown.rows.find((row) => row.entry).entry
    const station = entry.intent.station

    return station.verdict.state === 'review' && station.verdict.basis === 'reused' && entry.location.station.state === 'unknown' && same(entry.review, ['station']) === true && rowOf(shown, 30).flags.review.length === 1 ? true : short([station.verdict, entry.location.station, entry.review])
  })
  add('reuse: a waypoint the game refreshed (only its creation time is later) is the same station: it stays held, compared and with no step to pick it again, while another system, number or name still reads as another waypoint', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save), { station: ['waypoint', 61], base: null })

    const refreshed = edited(save, (copy) => { found(copy.waypoints, 61).created = 99999 })
    const { shown } = await readOn(m, w, refreshed)
    const row = rowOf(shown, 30)
    const station = row.entry.intent.station
    const other = async (change) => (await readOn(m, w, edited(save, (copy) => { Object.assign(found(copy.waypoints, 61), { created: 99999, ...change }) }))).shown.rows.find((item) => item.entry).entry.intent.station.verdict
    const elsewhere = await other({ systemId: 2, x: 1, y: 1 })
    const renumbered = await other({ number: 7 })
    const renamed = await other({ name: 'Another marker' })

    return station.verdict.state === 'held' && station.verdict.basis === 'confirmed' && row.entry.location.station.state === 'off' && row.flags.review.length === 0 && !m.fs.checklistOf(row).some((step) => step.key === 'repick') && elsewhere.state === 'review' && renumbered.state === 'review' && renamed.state === 'review' ? true : short([station.verdict, row.entry.location.station.state, elsewhere, renumbered, renamed])
  })
  add('reuse: a waypoint that took the ID, number and name again is the same station only where it holds the anchor it had: another tied body, a tied waypoint made a fixed point (or the reverse) and a fixed point beyond the game\'s one unit read under review, while a tied waypoint whose body moved and a fixed point within the unit stay held', async () => {
    const verdictOf = async (id, change) => {
      const w = world(m)
      const save = SAVE()

      await kept(m, w, scope(), await open(m, save), { station: ['waypoint', id], base: null })

      return (await readOn(m, w, edited(save, (copy) => { Object.assign(found(copy.waypoints, id), { created: 150000, ...change }) }))).shown.rows.find((item) => item.entry).entry.intent.station.verdict
    }
    const untied = { elsewhere: await verdictOf(61, { x: 900000, y: 400000 }), tied: await verdictOf(61, { orbit: 101, x: 5000, y: 0 }), near: await verdictOf(61, { x: 3000.4, y: 2999.6 }), far: await verdictOf(61, { x: 3001.5 }) }
    const tied = { moved: await verdictOf(60, { x: 777, y: 888 }), another: await verdictOf(60, { orbit: 101 }), loosened: await verdictOf(60, { orbit: 0 }) }

    return [untied.elsewhere, untied.tied, untied.far, tied.another, tied.loosened].every((verdict) => verdict.state === 'review') && [untied.near, tied.moved].every((verdict) => verdict.state === 'held' && verdict.basis === 'confirmed') ? true : short([untied, tied])
  })
  add('reuse: a waypoint whose tie or position the save does not give is not shown to be the one confirmed, takes no note and no confirmation, and a note kept before the anchor was recorded reads under review', async () => {
    const w = world(m)
    const save = SAVE()
    const record = await kept(m, w, scope(), await open(m, save), { station: ['waypoint', 61], base: null })
    const unknownTie = edited(save, (copy) => { found(copy.waypoints, 61).orbit = null })
    const unknownPoint = edited(save, (copy) => { Object.assign(found(copy.waypoints, 61), { x: null }) })
    const read = async (copySave) => (await readOn(m, w, copySave)).shown.rows.find((item) => item.entry).entry.intent.station.verdict
    const tie = await read(unknownTie)
    const point = await read(unknownPoint)
    const unanchored = { ...record.payload.station.confirmed }

    delete unanchored.anchor
    w.repo.update(scope(), record.uuid, record.revision, { payload: { ...record.payload, station: { ...record.payload.station, confirmed: unanchored } } })

    const old = await readOn(m, w, save)
    const oldVerdict = old.shown.rows.find((item) => item.entry).entry.intent.station.verdict
    const refused = await keep(m, world(m), scope(), await open(m, unknownTie), { station: ['waypoint', 61], base: null })
    const refusedPoint = await keep(m, world(m), scope(), await open(m, unknownPoint), { station: ['waypoint', 61], base: null })
    const unknownRead = await readOn(m, w, unknownTie)
    const refusedConfirm = await m.fs.confirmTarget(w.repo, scope(), { entry: unknownRead.read.entries[0], role: 'station', context: unknownRead.ctx })
    const renewed = await m.fs.confirmTarget(w.repo, scope(), { entry: old.read.entries[0], role: 'station', context: old.ctx })
    const after = await read(save)

    return tie.state === 'review' && point.state === 'review' && oldVerdict.state === 'review' && refused.ok === false && refused.code === 'unverifiable' && refusedPoint.ok === false && refusedPoint.code === 'unverifiable' && refusedConfirm.ok === false && refusedConfirm.code === 'unverifiable' && renewed.ok === true && after.state === 'held' ? true : short([tie, point, oldVerdict, refused, refusedPoint, refusedConfirm, renewed, after])
  })
  add('reuse: ship classes the save does not give are unknown, never an empty list that matches another: such an undated fleet cannot take a note or a confirmation and holds none, while a fleet with no ship at all is held by its empty list', async () => {
    const undated = edited(SAVE(), (copy) => { found(copy.fleets, 30).created = null })
    const unknown = edited(undated, (copy) => { Object.assign(found(copy.fleets, 30), { classes: null, ships: 2 }) })
    const empty = edited(undated, (copy) => { Object.assign(found(copy.fleets, 30), { classes: null, ships: 0 }) })
    const refused = await keep(m, world(m), scope(), await open(m, unknown))
    const w = world(m)
    const record = await kept(m, w, scope(), await open(m, undated))
    const stored = { ...record.payload, fleet: { ...record.payload.fleet, confirmed: { ...record.payload.fleet.confirmed, classes: null } } }

    w.repo.update(scope(), record.uuid, record.revision, { payload: stored })

    const bothUnknown = await readOn(m, w, unknown)
    const kept2 = world(m)

    await kept(m, kept2, scope(), await open(m, undated))

    const lostClasses = await readOn(m, kept2, unknown)
    const attach = await m.fs.confirmTarget(kept2.repo, scope(), { entry: lostClasses.shown.review[0], role: 'fleet', context: lostClasses.ctx })
    const v = world(m)

    await kept(m, v, scope(), await open(m, empty))

    const noShips = await readOn(m, v, empty)

    return refused.ok === false && refused.code === 'unverifiable' && bothUnknown.read.entries[0].intent.fleet.verdict.state === 'review' && bothUnknown.shown.review.length === 1 && rowOf(bothUnknown.shown, 30).entry === null && lostClasses.read.entries[0].intent.fleet.verdict.state === 'review' && lostClasses.shown.review.length === 1 && attach.ok === false && attach.code === 'unverifiable' && kept2.repo.list(scope(), { kind: m.fs.STATION_KIND })[0].payload.fleet.confirmed.classes.length === 2 && noShips.read.entries[0].intent.fleet.verdict.state === 'held' && noShips.read.entries[0].intent.fleet.verdict.basis === 'confirmed' ? true : short([refused.code, bothUnknown.read.entries[0].intent.fleet.verdict, lostClasses.read.entries[0].intent.fleet.verdict, attach.code, noShips.read.entries[0].intent.fleet.verdict])
  })
  add('reuse: a colony the save does not date is held by the player\'s confirmation, and reads under review when another colony holds the ID', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save), { station: null })

    const same = await readOn(m, w, save)
    const other = edited(save, (copy) => { Object.assign(found(copy.colonies, 10), { name: 'Other', bodyId: 101, speciesId: 9 }) })
    const changed = await readOn(m, w, other)

    return same.read.entries[0].intent.base.verdict.state === 'held' && same.read.entries[0].intent.base.verdict.basis === 'confirmed' && changed.read.entries[0].intent.base.verdict.state === 'review' && changed.read.entries[0].location.base.state === 'unknown' ? true : short([same.read.entries[0].intent.base.verdict, changed.read.entries[0].intent.base.verdict])
  })

  // ---- stale ----
  add('stale: a deleted station or base leaves the note stale with the name and system it had, and no location for it', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const gone = edited(save, (copy) => {
      copy.bodies = copy.bodies.filter((row) => row.id !== 100)
      copy.colonies = copy.colonies.filter((row) => row.id !== 10)
    })
    const { shown } = await readOn(m, w, gone, scope(), { bodyIds: [100, 101, 200] })
    const row = rowOf(shown, 30)

    return same(row.entry.stale, ['station', 'base']) === true && row.entry.intent.station.name === 'Earth' && row.entry.intent.station.systemName === 'Sol' && row.entry.intent.base.name === 'Earth Prime' && row.location.station.state === 'unknown' && row.location.base.state === 'unknown' && same(row.flags.stale, ['station', 'base']) === true && row.flags.attention === true ? true : short([row.entry.stale, row.location, row.flags])
  })
  add('stale: a station that is still there is not stale, and a rename keeps the link and shows the new name beside the kept one', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const renamed = edited(save, (copy) => { found(copy.bodies, 100).name = 'Terra' })
    const { shown } = await readOn(m, w, renamed)
    const entry = rowOf(shown, 30).entry

    return entry.stale.length === 0 && entry.intent.station.verdict.state === 'held' && entry.intent.station.name === 'Earth' && entry.intent.station.nowNamed === 'Terra' && entry.location.station.state === 'on' ? true : short([entry.stale, entry.intent.station])
  })

  // ---- unread ----
  add('unread: a kind of object the save could not give reads not checked, never gone or stale, and nothing is compared with it', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const noColonies = await readOn(m, w, save, scope(), { failing: ['from FCT_Population'] })
    const noFleets = await readOn(m, w, save, scope(), { failing: ['select FCT_Fleet.FleetID'] })
    const base = noColonies.read.entries[0]
    const unchecked = noFleets.shown.unchecked

    return base.intent.base.verdict.state === 'unread' && base.stale.length === 0 && base.location.base.state === 'unknown' && base.location.station.state === 'on' && noFleets.ctx.failed.fleet && unchecked.length === 1 && noFleets.shown.archived.length === 0 && unchecked[0].location.station.state === 'unknown' ? true : short([base.intent.base.verdict, unchecked.length, noFleets.shown.archived.length])
  })
  add('unread: notes read without the objects of the save (still loading) are not checked, never gone', async () => {
    const w = world(m)

    await kept(m, w, scope(), await open(m, SAVE()))

    const read = m.fs.readStations(w.repo, scope(), null)

    return read.entries.length === 1 && read.entries[0].fleetState === 'unread' && read.entries[0].stale.length === 0 && read.entries[0].review.length === 0 ? true : short(read.entries[0])
  })
  add('unread: a body that was not asked for reads not checked, never gone', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const { read } = await readOn(m, w, save, scope(), { bodyIds: [] })
    const withoutBodies = m.fs.readStations(w.repo, scope(), { ...(await open(m, save)), objects: { ...(await open(m, save)).objects, body: undefined } })

    return read.entries[0].intent.station.verdict.state === 'gone' && withoutBodies.entries[0].intent.station.verdict.state === 'unread' && withoutBodies.entries[0].stale.length === 0 ? true : short([read.entries[0].intent.station.verdict, withoutBodies.entries[0].intent.station.verdict])
  })

  // ---- separation ----
  add('separation: a row keeps the note, the place of the fleet, the location against the note and the saved orders apart, and a note\'s words are never in the orders nor an order\'s words in the note', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const { shown } = await readOn(m, w, save)
    const row = rowOf(shown, 30)
    const text = (value) => JSON.stringify(value)

    return same(Object.keys(row.intent).sort(), ['base', 'fleet', 'note', 'station']) === true && same(Object.keys(row.place).sort(), ['inOrbit', 'orbitBodyId', 'orbitName', 'systemId', 'systemName']) === true && same(Object.keys(row.orders).sort(), ['destination', 'list', 'read', 'standoff']) === true && same(Object.keys(row.location).sort(), ['base', 'station']) === true && !text(row.intent).includes('ORDER-MARKER') && !text(row.place).includes('ORDER-MARKER') && !text(row.place).includes(KEY_NOTE) && !text(row.location).includes('ORDER-MARKER') && !text(row.location).includes(KEY_NOTE) && !text(row.orders).includes(KEY_NOTE) && text(row.orders).includes('ORDER-MARKER') && row.intent.note === KEY_NOTE ? true : short(row)
  })
  add('separation: changing the saved orders changes nothing of the note or the location, and changing the note nothing of the orders or the place', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save), { note: 'one' })

    const base = rowOf((await readOn(m, w, save)).shown, 30)
    const otherOrders = rowOf((await readOn(m, w, edited(save, (copy) => { copy.orders = [] }))).shown, 30)
    const entry = w.repo.list(scope(), { kind: m.fs.STATION_KIND })[0]
    const outcome = await m.fs.saveStation(w.repo, scope(), { entry: { ...(await readOn(m, w, save)).read.entries[0], revision: entry.record.revision }, note: 'two', context: await open(m, save) })
    const otherNote = rowOf((await readOn(m, w, save)).shown, 30)

    return outcome.ok === true && same(otherOrders.intent, base.intent) === true && same(otherOrders.location, base.location) === true && otherOrders.orders.list.length === 0 && same(otherNote.orders, base.orders) === true && same(otherNote.place, base.place) === true && otherNote.intent.note === 'two' ? true : short([outcome, otherOrders.orders, otherNote.intent.note])
  })
  add('separation: a fleet with no note has no note and no location, only the place it is in and the orders saved', async () => {
    const w = world(m)
    const { shown } = await readOn(m, w, SAVE())
    const row = rowOf(shown, 30)

    return row.entry === null && row.intent === null && row.location === null && row.place.orbitName === 'Earth' && row.orders.list.length === 1 && row.orders.destination === null && row.orders.standoff === null ? true : short(row)
  })

  // ---- orders ----
  add('orders: the saved orders are listed as saved, in the order of the queue, and the last is said to end at the station only when it does', async () => {
    const w = world(m)
    const save = edited(SAVE(), (copy) => {
      copy.orders = [order(2, 30, 'second', 2, 101), order(1, 30, 'first', 5, 61), order(3, 31, 'other', 2, 100)]
    })

    await kept(m, w, scope(), await open(m, save))

    const toStation = edited(save, (copy) => { copy.orders = [order(1, 30, 'to the body', 2, 100)] })
    const toOther = edited(save, (copy) => { copy.orders = [order(1, 30, 'to another body', 2, 101)] })
    const sameIdOtherKind = edited(save, (copy) => { copy.orders = [order(1, 30, 'a waypoint with the id of the body', 5, 100)] })
    const read = async (source) => rowOf((await readOn(m, w, source)).shown, 30).orders

    const queued = await read(save)

    return same(queued.list.map((row) => row.text), ['second', 'first']) === true && (await read(toStation)).destination === 'station' && (await read(toOther)).destination === 'other' && (await read(sameIdOtherKind)).destination === 'other' ? true : short([queued.list.map((row) => row.text), queued.destination])
  })
  add('orders: a last order that names the station is not said to end there when a minimum distance holds the fleet back: the standoff is none for 0, set for more and unknown for null, and only the destination is claimed', async () => {
    const w = world(m)

    await kept(m, w, scope(), await open(m, SAVE()))

    const at = async (minDistance) => rowOf((await readOn(m, w, edited(SAVE(), (copy) => { copy.orders = [order(1, 30, 'to the body', 2, 100, { minDistance })] }))).shown, 30).orders
    const none = await at(0)
    const set = await at(5000)
    const unknown = await at(null)
    const other = rowOf((await readOn(m, w, edited(SAVE(), (copy) => { copy.orders = [order(1, 30, 'elsewhere', 2, 101, { minDistance: 5000 })] }))).shown, 30).orders

    return none.destination === 'station' && none.standoff === 'none' && set.destination === 'station' && set.standoff === 'set' && unknown.destination === 'station' && unknown.standoff === 'unknown' && other.destination === 'other' && other.standoff === null && !('headsToStation' in set) ? true : short([none, set, unknown, other])
  })
  add('orders: a last order whose destination kind or ID the save leaves null is not said to have another destination: it is unknown unless the other value already shows a mismatch, and unknown is not said to name the station', async () => {
    const w = world(m)

    await kept(m, w, scope(), await open(m, SAVE()))

    const at = async (destinationType, destinationId) => rowOf((await readOn(m, w, edited(SAVE(), (copy) => { copy.orders = [order(1, 30, 'to somewhere', destinationType, destinationId, { minDistance: 5000 })] }))).shown, 30).orders
    const noKind = await at(null, 100)
    const noId = await at(2, null)
    const neither = await at(null, null)
    const mismatchWithNoKind = await at(null, 101)
    const mismatchWithNoId = await at(5, null)

    return [noKind, noId, neither].every((orders) => orders.destination === 'unknown' && orders.standoff === null) && mismatchWithNoKind.destination === 'other' && mismatchWithNoId.destination === 'other' ? true : short([noKind, noId, neither, mismatchWithNoKind, mismatchWithNoId].map((orders) => orders.destination))
  })
  add('orders: a fleet with no saved order has an empty queue read, and one that could not be read says so', async () => {
    const w = world(m)
    const empty = edited(SAVE(), (copy) => { copy.orders = [] })
    const row = rowOf((await readOn(m, w, empty)).shown, 30)
    const none = m.fs.stationRows({ fleets: new Map([[30, fleetRow()]]), entries: [], orders: null }).rows[0]

    return row.orders.read === true && row.orders.list.length === 0 && none.orders.read === false && none.orders.destination === null ? true : short([row.orders, none.orders])
  })

  // ---- checklist ----
  add('checklist: a fleet off its station and its base is told to move, and one on station is told nothing but to open it', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const on = rowOf((await readOn(m, w, save)).shown, 30)
    const away = edited(save, (copy) => { Object.assign(found(copy.fleets, 30), { orbit: 101, x: 5000, y: 0 }) })
    const off = rowOf((await readOn(m, w, away)).shown, 30)

    return same(m.fs.checklistOf(on).map((step) => step.key), ['open']) === true && same(m.fs.checklistOf(off).map((step) => `${step.key}:${step.role || ''}`), ['open:', 'move:station', 'resupply:base']) === true ? true : short([m.fs.checklistOf(on), m.fs.checklistOf(off)])
  })
  add('checklist: a fleet at the body by position only is told to go into orbit, a station or base that is gone or under review to be picked again, and a fleet with no note gets no steps', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const byPosition = edited(save, (copy) => { Object.assign(found(copy.fleets, 30), { orbit: 0, x: 1000, y: 2000 }) })
    const position = rowOf((await readOn(m, w, byPosition)).shown, 30)
    const goneSave = edited(save, (copy) => { copy.bodies = copy.bodies.filter((row) => row.id !== 100) })
    const gone = rowOf((await readOn(m, w, goneSave, scope(), { bodyIds: [101, 200] })).shown, 30)
    const reused = edited(save, (copy) => { Object.assign(found(copy.colonies, 10), { name: 'Other', speciesId: 9 }) })
    const review = rowOf((await readOn(m, w, reused)).shown, 30)
    const bare = rowOf((await readOn(m, world(m), save)).shown, 31)

    return same(m.fs.checklistOf(position).map((step) => step.key), ['open', 'orbit', 'resupply']) === true && m.fs.checklistOf(gone).some((step) => step.key === 'repick' && step.role === 'station') && m.fs.checklistOf(review).some((step) => step.key === 'repick' && step.role === 'base') && !m.fs.checklistOf(gone).some((step) => step.key === 'move') && m.fs.checklistOf(bare).length === 0 ? true : short([m.fs.checklistOf(position), m.fs.checklistOf(gone), m.fs.checklistOf(review)])
  })
  add('checklist: the steps hold objects and keys, never a link or an explainer', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const away = edited(save, (copy) => { Object.assign(found(copy.fleets, 30), { orbit: 101, x: 5000, y: 0 }) })
    const steps = m.fs.checklistOf(rowOf((await readOn(m, w, away)).shown, 30))
    const links = steps.filter((step) => Object.keys(step).some((key) => /link|url|explain|href/i.test(key)))

    return steps.length > 0 && links.length === 0 ? true : short(steps)
  })

  // ---- marks ----
  add('marks: a comparison is a provenance result at the rule\'s own verification and unavailable where nothing is known, and a distance a result in km', () => {
    const on = cmp(fleetRow({ orbitBodyId: 100, x: 1, y: 1 }), bodyRow())
    const unknown = cmp(fleetRow({ systemId: null }), bodyRow())
    const off = cmp(fleetRow({ x: 3000, y: 3000 }), bodyRow())
    const rule = m.provenance.getRule('fleetStation.onStation')

    return on.result.status === rule.verification && on.result.rule.id === 'fleetStation.onStation' && unknown.result.status === 'unavailable' && off.distance.status === m.provenance.getRule('fleetStation.distance').verification && off.distance.rule.id === 'fleetStation.distance' && off.distance.units === 'km' && near(off.distance.value, Math.hypot(2000, 1000)) ? true : short([on.result, unknown.result, off.distance])
  })
  add('marks: the notes count has its own rule, confirmed because it reads only the scenario records', () => {
    const rule = m.provenance.getRule('fleetStation.notes')

    return rule && rule.verification === 'confirmed' ? true : short(rule)
  })

  // ---- isolation ----
  add('isolation: another race, another branch and another campaign never list a note, and a note shared with the campaign lists on every branch', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context)
    await kept(m, w, scope(), context, { fleet: 31, station: ['body', 200], base: null, policy: 'campaign' })

    const names = (where) => m.fs.readStations(w.repo, where, null).entries.map((entry) => entry.intent.fleet.name)

    return same(names(scope()), ['1st Fleet', '2nd Fleet']) === true && same(names(scope('b2')), ['2nd Fleet']) === true && names(scope('b1', RACE + 1)).length === 0 && names(scope('b1', RACE, 'c2')).length === 0 && m.fs.readStations(w.repo, scope('b2'), null).entries[0].otherBranch === true ? true : short([names(scope()), names(scope('b2'))])
  })
  add('isolation: a note is kept for the branch by default, and the notes survive a restart in the campaign\'s scenario file', async () => {
    const inst = memory()
    const w = world(m, inst)

    await kept(m, w, scope(), await open(m, SAVE()))

    const later = world(m, inst)

    return later.repo.list(scope(), { kind: m.fs.STATION_KIND })[0].record.association.policy === 'branch' && m.fs.readStations(later.repo, scope(), null).entries.length === 1 && [...inst.files.keys()].every((name) => name.startsWith('campaign-c1')) ? true : short([...inst.files.keys()])
  })

  // ---- write ----
  add('write: a note is one record of the repository with the fleet, the station and the base as its links, in that order, each with the fingerprint of its kind', async () => {
    const w = world(m)
    const context = await open(m, SAVE())
    const record = await kept(m, w, scope(), context)
    const types = record.links.map((link) => link.type)

    return same(types, ['fleet', 'body', 'colony']) === true && record.kind === m.fs.STATION_KIND && record.links.every((link) => link.fingerprint === m.fs.STATION_TARGETS[link.type].fingerprint(context.objects[link.type].get(link.id))) && record.payload.fleet.origin.branchId === 'b1' && record.payload.station.confirmed.name === 'Earth' && record.assumptions.length > 0 ? true : short(record) + (types.join())
  })
  add('write: an edit keeps what it is not given, clears what it is given as null and replaces what it is given, and never changes the fleet', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context)

    const entryOf = async () => (await readOn(m, w, SAVE())).read.entries[0]
    const linksOf = () => w.repo.list(scope(), { kind: m.fs.STATION_KIND })[0].links.map((link) => `${link.type}:${link.id}`)
    const keepOnly = await m.fs.saveStation(w.repo, scope(), { entry: await entryOf(), note: 'only words', context })
    const afterKeep = linksOf()
    const cleared = await m.fs.saveStation(w.repo, scope(), { entry: await entryOf(), base: null, note: 'only words', context })
    const afterClear = linksOf()
    const replaced = await m.fs.saveStation(w.repo, scope(), { entry: await entryOf(), station: aim(context, 'body', 101), note: 'only words', context })
    const afterReplace = linksOf()
    const fleetChange = await m.fs.saveStation(w.repo, scope(), { entry: await entryOf(), fleet: aim(context, 'fleet', 31), context })

    return keepOnly.ok && cleared.ok && replaced.ok && same(afterKeep, ['fleet:30', 'body:100', 'colony:10']) === true && same(afterClear, ['fleet:30', 'body:100']) === true && same(afterReplace, ['fleet:30', 'body:101']) === true && fleetChange.ok === false && fleetChange.code === 'invalid-note' ? true : short([afterKeep, afterClear, afterReplace, fleetChange])
  })
  add('write: a stale edit is refused with what is stored and written over only when that is asked', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context)

    const first = (await readOn(m, w, SAVE())).read.entries[0]
    const other = await m.fs.saveStation(w.repo, scope(), { entry: first, note: 'from elsewhere', context })
    const stale = await m.fs.saveStation(w.repo, scope(), { entry: first, note: 'mine', context })
    const stored = w.repo.list(scope(), { kind: m.fs.STATION_KIND })[0].payload.note
    const over = await m.fs.saveStation(w.repo, scope(), { entry: first, note: 'written over', context, overwrite: true })

    return other.ok && stale.ok === false && stale.code === 'revision-conflict' && stale.stored.note === 'from elsewhere' && stored === 'from elsewhere' && over.ok === true && w.repo.list(scope(), { kind: m.fs.STATION_KIND })[0].payload.note === 'written over' ? true : short([stale, stored, over.ok])
  })
  add('write: an object picked from another race, campaign, branch or save, or no longer in the save as picked, is refused and nothing is written', async () => {
    const w = world(m)
    const context = await open(m, SAVE())
    const otherRace = { ...context, RaceID: RACE + 1 }
    const otherBranch = { ...context, branchId: 'b2' }
    const moved = { ...context, objects: { ...context.objects, body: new Map([[100, { ...context.objects.body.get(100), bodyClass: 99 }]]) } }
    const outcomes = [await keep(m, w, scope(), otherRace), await keep(m, w, scope(), otherBranch), await keep(m, w, scope(), { ...context, objects: { ...context.objects, fleet: new Map() } }), await m.fs.saveStation(w.repo, scope(), { fleet: aim(context, 'fleet', 30), context: null })]
    const wrongKind = await m.fs.saveStation(w.repo, scope(), { fleet: aim(context, 'fleet', 30), station: aim(context, 'colony', 10), context })
    const staleRow = await m.fs.saveStation(w.repo, scope(), { fleet: aim(context, 'fleet', 30), station: { type: 'body', row: moved.objects.body.get(100) }, context })

    return outcomes.every((outcome) => outcome.ok === false) && outcomes[0].code === 'link-out-of-scope' && outcomes[1].code === 'link-out-of-scope' && wrongKind.ok === false && staleRow.ok === false && staleRow.code === 'link-stale' && w.repo.list(scope(), { kind: m.fs.STATION_KIND }).length === 0 ? true : short([outcomes.map((o) => o.code), wrongKind.code, staleRow.code])
  })
  add('write: no repository and no settled scope keep nothing, and a note is deleted over its revision only', async () => {
    const w = world(m)
    const context = await open(m, SAVE())
    const noRepository = await m.fs.saveStation(null, scope(), { fleet: aim(context, 'fleet', 30), context })
    const noScope = await m.fs.saveStation(w.repo, null, { fleet: aim(context, 'fleet', 30), context })

    await kept(m, w, scope(), context)

    const entry = (await readOn(m, w, SAVE())).read.entries[0]

    await m.fs.saveStation(w.repo, scope(), { entry, note: 'changed', context })

    const stale = await m.fs.deleteStation(w.repo, scope(), entry)
    const fresh = await m.fs.deleteStation(w.repo, scope(), (await readOn(m, w, SAVE())).read.entries[0])

    return noRepository.ok === false && noRepository.code === 'no-repository' && noScope.ok === false && stale.ok === false && stale.code === 'revision-conflict' && fresh.ok === true && w.repo.list(scope(), { kind: m.fs.STATION_KIND }).length === 0 ? true : short([noRepository.code, noScope.code, stale.code, fresh.ok])
  })
  add('write: a pick is not a note of two fleets: a blank pick, a wrong kind and a note of no fleet are refused', async () => {
    const w = world(m)
    const context = await open(m, SAVE())
    const noFleet = await m.fs.saveStation(w.repo, scope(), { context })
    const wrong = await m.fs.saveStation(w.repo, scope(), { fleet: aim(context, 'body', 100), context })
    const long = await m.fs.saveStation(w.repo, scope(), { fleet: aim(context, 'fleet', 30), note: 'x'.repeat(m.fs.NOTE_LENGTH + 1), context })

    return noFleet.ok === false && wrong.ok === false && long.ok === false && long.code === 'invalid-note' && w.repo.list(scope(), { kind: m.fs.STATION_KIND }).length === 0 ? true : short([noFleet.code, wrong.code, long.code])
  })

  // ---- payload ----
  const ref = (type, id, extra = {}) => ({ type, id, name: 'N', systemId: 1, systemName: 'Sol', origin: { campaignId: 'c1', branchId: 'b1' }, confirmed: { fingerprint: `${type}|1`, name: 'N', classes: type === 'fleet' ? [5] : null, gameTime: 10 }, ...extra })
  const note = (extra = {}) => ({ fleet: ref('fleet', 30), station: ref('body', 100), base: ref('colony', 10), note: 'x', ...extra })

  add('payload: a valid note is accepted with a station or a base left out (null), and a note of one fleet alone', () => {
    const ok = [note(), note({ station: null }), note({ base: null }), note({ station: null, base: null, note: '' }), note({ station: ref('waypoint', 60) })]

    return ok.every((payload) => m.fs.problemsOf(payload).length === 0) ? true : short(ok.map((payload) => m.fs.problemsOf(payload)))
  })
  add('payload: a fleet that is not a fleet, a station that is a colony, a base that is a body, a missing origin or confirmation, an unknown key, a missing station and a note over its length are refused', () => {
    const bad = [
      note({ fleet: ref('body', 30) }),
      note({ station: ref('colony', 10) }),
      note({ base: ref('body', 100) }),
      note({ fleet: ref('fleet', 30, { origin: undefined }) }),
      note({ fleet: ref('fleet', 30, { confirmed: undefined }) }),
      note({ station: ref('body', 100, { confirmed: { fingerprint: 'x', name: 'N', classes: 'five', gameTime: 1 } }) }),
      { ...note(), order: 'move' },
      { fleet: ref('fleet', 30), base: null, note: '' },
      note({ note: 'x'.repeat(m.fs.NOTE_LENGTH + 1) }),
      note({ note: undefined }),
      null,
    ]
    const accepted = bad.map((payload, index) => [index, m.fs.problemsOf(payload).length]).filter(([, count]) => count === 0)

    return accepted.length === 0 ? true : short(accepted)
  })
  add('payload: a record of the repository with a payload the adapter refuses is not kept, and the fingerprint of a kind that is not one is refused', async () => {
    const w = world(m)
    let refused = null

    try {
      w.repo.create(scope(), { kind: m.fs.STATION_KIND, policy: 'branch', links: [], payload: note({ station: ref('colony', 10) }) })
    } catch (error) {
      refused = error.code
    }

    return refused === 'invalid-payload' && w.repo.list(scope(), { kind: m.fs.STATION_KIND }).length === 0 && (() => { try { m.fs.stationAdapter.fingerprint('tech', {}); return false } catch (error) { return true } })() ? true : short(refused)
  })

  // ---- loaders ----
  add('loaders: every statement the panel sends is a select, so keeping a note never writes the save', async () => {
    const w = world(m)
    const context = await open(m, SAVE())

    await kept(m, w, scope(), context)
    await m.fs.loadFleetOrders(context.database, { GameID: GAME, RaceID: RACE })
    await m.fs.loadStationBodies(context.database, { GameID: GAME, RaceID: RACE, bodyIds: [100], systemId: 1 })

    const writes = context.database.sent.filter(({ sql }) => !/^\s*select\b/i.test(sql) || /\b(insert|update|delete|drop|alter|create|replace)\b\s/i.test(sql.replace(/'[^']*'/g, '')))

    return context.database.sent.length >= 6 && writes.length === 0 ? true : short(writes)
  })
  add('loaders: a column the save leaves null stays null: no orbit, position, creation time or class is read as 0', async () => {
    const save = edited(SAVE(), (copy) => {
      Object.assign(found(copy.fleets, 31), { orbit: null, assigned: null, x: null, y: null, created: null, classes: null, ships: null })
      Object.assign(found(copy.waypoints, 61), { orbit: null, x: null, y: null, created: null, name: null, type: 1 })
    })
    const context = await open(m, save)
    const flt = context.objects.fleet.get(31)
    const way = context.objects.waypoint.get(61)

    return flt.orbitBodyId === null && flt.assignedPopulationId === null && flt.x === null && flt.y === null && flt.created === null && flt.classes === null && flt.ships === null && way.orbitBodyId === null && way.x === null && way.created === null && way.name.length > 0 ? true : short([flt, way])
  })
  add('loaders: ship classes that the save does not give are unknown when ships are there and empty only for a fleet with no ship', async () => {
    const save = edited(SAVE(), (copy) => {
      Object.assign(found(copy.fleets, 30), { classes: null, ships: 3 })
      Object.assign(found(copy.fleets, 31), { classes: null, ships: 0 })
    })
    const context = await open(m, save)
    const part = edited(SAVE(), (copy) => { Object.assign(found(copy.fleets, 30), { classes: [4], ships: 2 }) })

    return context.objects.fleet.get(30).classes === null && same(context.objects.fleet.get(31).classes, []) === true && same((await open(m, part)).objects.fleet.get(30).classes, [4]) === true ? true : short([context.objects.fleet.get(30).classes, context.objects.fleet.get(31).classes])
  })
  add('loaders: a waypoint marked for deletion is not read, and the row of a fleet carries the body it orbits by name', async () => {
    const save = edited(SAVE(), (copy) => { copy.waypoints.push(waypoint(62, 1, { type: m.placeData.MARKED_FOR_DELETION, number: 3 })) })
    const context = await open(m, save)

    return context.objects.waypoint.has(62) === false && context.objects.waypoint.size === 2 && context.objects.fleet.get(30).orbitName === 'Earth' && context.objects.fleet.get(31).orbitName === '' ? true : short([[...context.objects.waypoint.keys()], context.objects.fleet.get(30).orbitName])
  })
  add('loaders: a kind that cannot be read is named in failed and left out, the other kinds are read, and the bodies throw rather than read as gone', async () => {
    const context = await open(m, SAVE(), scope(), { failing: ['from FCT_Population'] })
    const failing = fakeSave(SAVE(), { failing: ['select FCT_SystemBody.'] })
    let thrown = null

    try {
      await m.fs.loadStationBodies(failing, { GameID: GAME, RaceID: RACE, bodyIds: [100] })
    } catch (error) {
      thrown = error.message
    }

    return context.failed.colony && !('colony' in context.objects) && context.objects.fleet instanceof Map && context.objects.waypoint instanceof Map && thrown !== null ? true : short([context.failed, Object.keys(context.objects), thrown])
  })
  add('loaders: the bodies are read a batch at a time and those of the picked system by the system', async () => {
    const database = fakeSave(SAVE())
    const ids = Array.from({ length: m.fs.BODIES_PER_READ + 5 }, (_value, index) => 1000 + index)

    await m.fs.loadStationBodies(database, { GameID: GAME, RaceID: RACE, bodyIds: ids })

    const batches = database.sent.map(({ sql }) => (/SystemBodyID in \(([^)]*)\)/.exec(sql) || [0, ''])[1].split(',').filter(Boolean).length)
    const picked = fakeSave(SAVE())
    const bodies = await m.fs.loadStationBodies(picked, { GameID: GAME, RaceID: RACE, systemId: 2 })

    return same(batches, [m.fs.BODIES_PER_READ, 5]) === true && same([...bodies.keys()], [200]) === true && picked.sent[0].replacements.SystemID === 2 ? true : short([batches, [...bodies.keys()]])
  })
  add('loaders: the orders keep the queue\'s order and a column left null is null', async () => {
    const database = fakeSave(edited(SAVE(), (copy) => { copy.orders = [order(1, 30, null, null, null, { minDistance: null, arrived: null }), order(2, 30, 'x', 2, 100)] }))
    const orders = await m.fs.loadFleetOrders(database, { GameID: GAME, RaceID: RACE })
    const [first, second] = orders.get(30)

    return first.text === null && first.destinationType === null && first.minDistance === null && first.arrived === null && second.arrived === false && second.minDistance === 0 ? true : short([first, second])
  })

  // ---- branch ----
  add('branch: a note made on one branch never attaches to an object that took the same ID, creation tick, name and classes after the branches parted: the fleet, the station and the base stay under review and nothing is compared', async () => {
    const w = world(m)
    const save = edited(SAVE(), (copy) => { copy.waypoints.push(waypoint(63, 1, { created: 2500, number: 3, x: 3000, y: 3000 })) })

    await kept(m, w, scope(), await open(m, save), { fleet: 31, station: ['waypoint', 63], base: ['colony', 11], policy: 'campaign' })

    const home = await readOn(m, w, save, scope('b1'))
    const { shown, read } = await readOn(m, w, save, scope('b2'))
    const entry = read.entries[0]
    const row = rowOf(shown, 31)

    return home.read.entries[0].fleetState === 'held' && read.entries.length === 1 && entry.intent.fleet.verdict.state === 'review' && entry.intent.fleet.verdict.basis === 'unwitnessed' && entry.intent.station.verdict.state === 'review' && entry.intent.base.verdict.state === 'review' && row.entry === null && row.location === null && shown.review.length === 1 && entry.location.station.state === 'unknown' && entry.location.base.state === 'unknown' ? true : short([entry.intent.fleet.verdict, entry.intent.station.verdict, entry.intent.base.verdict, row.entry && row.entry.uuid])
  })
  add('branch: a confirmation made before the branches parted holds on the other branch, one made after does not, and the player\'s confirmation on the open branch does', async () => {
    const save = edited(SAVE(), (copy) => { found(copy.fleets, 30).created = null })
    const early = scope('b1', RACE, 'c1', 500)
    const late = scope('b1', RACE, 'c1', 3000)
    const w = world(m)
    const v = world(m)

    await kept(m, w, early, await open(m, save, early), { policy: 'campaign', station: null, base: ['colony', 10] })
    await kept(m, v, late, await open(m, save, late), { policy: 'campaign', station: null, base: ['colony', 10] })

    const before = (await readOn(m, w, save, scope('b2'))).read.entries[0]
    const after = await readOn(m, v, save, scope('b2'))
    const outcome = await m.fs.confirmTarget(v.repo, scope('b2'), { entry: after.shown.review[0], role: 'fleet', context: after.ctx })
    const confirmed = await readOn(m, v, save, scope('b2'))

    return before.intent.fleet.verdict.state === 'held' && before.intent.fleet.verdict.basis === 'confirmed' && before.intent.base.verdict.state === 'held' && after.shown.review.length === 1 && after.read.entries[0].intent.fleet.verdict.state === 'review' && after.read.entries[0].intent.base.verdict.state === 'review' && outcome.ok === true && confirmed.shown.review.length === 0 && rowOf(confirmed.shown, 30).entry !== null ? true : short([before.intent.fleet.verdict, after.read.entries[0].intent.fleet.verdict, outcome.code, confirmed.shown.review.length])
  })
  add('branch: an edit of a note on a branch other than the one it was confirmed on keeps the confirmation it has and never dates it to the open branch', async () => {
    const save = edited(SAVE(), (copy) => { found(copy.fleets, 30).created = null })
    const early = scope('b1', RACE, 'c1', 500)
    const w = world(m)
    const context = await open(m, save, scope('b2'))

    await kept(m, w, early, await open(m, save, early), { policy: 'campaign', station: null, base: ['colony', 10] })

    const entry = (await readOn(m, w, save, scope('b2'))).read.entries[0]
    const outcome = await m.fs.saveStation(w.repo, scope('b2'), { entry, note: 'edited on b2', context })
    const stored = w.repo.list(scope('b2'), { kind: m.fs.STATION_KIND })[0].payload
    const again = (await readOn(m, w, save, scope('b2'))).read.entries[0]

    return outcome.ok === true && stored.fleet.confirmed.gameTime === 500 && stored.fleet.origin.branchId === 'b1' && again.intent.fleet.verdict.state === 'held' && again.intent.note === 'edited on b2' ? true : short([outcome.code, stored.fleet.confirmed, again.intent.fleet.verdict])
  })

  // ---- ahead ----
  add('ahead: a note made after the game time of the open save is listed apart, never attached, compared or put on a checklist, and becomes current only by an explicit move to the save', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const earlier = scope('b1', RACE, 'c1', 50000)
    const { shown, read } = await readOn(m, w, save, earlier)
    const entry = read.entries[0]
    const row = rowOf(shown, 30)
    const apart = entry.ahead === true && shown.ahead.length === 1 && row.entry === null && row.location === null && m.fs.checklistOf(row).length === 0 && shown.review.length === 0 && shown.archived.length === 0 && shown.unchecked.length === 0 && shown.overlapping.length === 0 && entry.location.station.state === 'unknown' && entry.location.base.state === 'unknown' && entry.stale.length === 0 && entry.review.length === 0
    const current = (await readOn(m, w, save)).read.entries[0]
    const refused = await m.fs.rebaseStation(w.repo, scope(), current)
    const moved = await m.fs.rebaseStation(w.repo, earlier, entry)
    const after = await readOn(m, w, save, earlier)

    return apart && current.ahead === false && refused.ok === false && refused.code === 'not-ahead' && moved.ok === true && after.shown.ahead.length === 0 && rowOf(after.shown, 30).entry !== null && rowOf(after.shown, 30).location.station.state === 'on' ? true : short([apart, refused.code, moved.ok, after.shown.ahead.length])
  })
  add('ahead: a note made after the open save is kept, listed and deletable when its fleet is gone, and is not archived or reviewed as a current note', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const gone = edited(save, (copy) => { copy.fleets = copy.fleets.filter((row) => row.id !== 30) })
    const { shown, read } = await readOn(m, w, gone, scope('b1', RACE, 'c1', 50000))
    const removed = await m.fs.deleteStation(w.repo, scope('b1', RACE, 'c1', 50000), read.entries[0])

    return shown.ahead.length === 1 && shown.archived.length === 0 && shown.review.length === 0 && removed.ok === true && w.repo.list(scope(), { kind: m.fs.STATION_KIND }).length === 0 ? true : short([shown.ahead.length, shown.archived.length, removed.ok])
  })

  // ---- overlap ----
  add('overlap: sharing a note with the campaign, or keeping one for the campaign, is refused while the fleet has another note on any branch, and nothing is written', async () => {
    const w = world(m)
    const save = SAVE()
    const one = await open(m, save, scope('b1'))
    const two = await open(m, save, scope('b2'))

    await kept(m, w, scope('b1'), one)
    await kept(m, w, scope('b2'), two)

    const entry = (await readOn(m, w, save, scope('b1'))).read.entries[0]
    const widen = await m.fs.saveStation(w.repo, scope('b1'), { entry, policy: 'campaign', context: one })
    const create = await keep(m, w, scope('b3'), await open(m, save, scope('b3')), { policy: 'campaign' })
    const lone = world(m)

    await kept(m, lone, scope('b1'), one)

    const alone = await m.fs.saveStation(lone.repo, scope('b1'), { entry: (await readOn(m, lone, save, scope('b1'))).read.entries[0], policy: 'campaign', context: one })

    return widen.ok === false && widen.code === 'exists' && create.ok === false && create.code === 'exists' && w.repo.list(scope('b1'), { kind: m.fs.STATION_KIND })[0].record.association.policy === 'branch' && alone.ok === true && lone.repo.list(scope('b2'), { kind: m.fs.STATION_KIND }).length === 1 ? true : short([widen.code, create.code, alone.code])
  })
  add('overlap: notes of one fleet that overlap anyway are all listed, none is attached to the fleet, and none is dropped', async () => {
    const w = world(m)
    const save = SAVE()
    const first = await kept(m, w, scope('b1'), await open(m, save, scope('b1')), { note: 'one' })

    await kept(m, w, scope('b2'), await open(m, save, scope('b2')), { note: 'two' })
    w.repo.update(scope('b1'), first.uuid, first.revision, { policy: 'campaign' })

    const { shown, read } = await readOn(m, w, save, scope('b2'))
    const row = rowOf(shown, 30)

    return read.entries.length === 2 && same(shown.overlapping.map((entry) => entry.intent.note).sort(), ['one', 'two']) === true && row.entry === null && row.location === null && row.flags.overlap === 2 && row.flags.attention === true && shown.review.length === 0 && shown.archived.length === 0 ? true : short([read.entries.length, shown.overlapping.length, row.flags])
  })

  // ---- partly null rows ----
  add('orbit: a row that is there with a value null is not compared as off station: no position, a waypoint tied to no known body, a fleet with no known orbit against a station that could hold it', () => {
    const unknowns = [
      cmp(fleetRow({ orbitBodyId: 0, x: null, y: null }), bodyRow()),
      cmp(fleetRow({ orbitBodyId: 0 }), bodyRow({ x: null, y: null })),
      cmp(fleetRow({ orbitBodyId: 0 }), waypointRow({ orbitBodyId: null, x: null, y: null })),
      cmp(fleetRow({ orbitBodyId: 100, x: 5, y: 5 }), waypointRow({ orbitBodyId: null })),
      cmp(fleetRow({ orbitBodyId: null, x: 5, y: 5 }), bodyRow()),
      cmp(fleetRow({ orbitBodyId: null, x: 5, y: 5 }), waypointRow({ orbitBodyId: null })),
    ]
    const off = [cmp(fleetRow({ orbitBodyId: null, x: 5, y: 5 }), waypointRow({ orbitBodyId: 0 })), cmp(fleetRow({ orbitBodyId: 0, x: 5, y: 5 }), waypointRow({ orbitBodyId: null }))]
    const on = cmp(fleetRow({ orbitBodyId: 100, x: null, y: null }), bodyRow())

    return unknowns.every((result) => result.state === 'unknown' && result.result.status === 'unavailable' && result.distance === null) && off.every((result) => result.state === 'off') && on.state === 'on' && on.basis === 'orbit' ? true : short([unknowns.map((result) => result.state), off.map((result) => result.state), on.state])
  })
  add('orbit: a base is not compared as away from the fleet when the colony\'s body, the fleet\'s orbit or the fleet\'s assigned colony is null, and a known match is on whatever else is null', () => {
    const colonyRow = { type: 'colony', id: 10, bodyId: 100 }
    const unknowns = [m.fs.compareBase(fleetRow({ orbitBodyId: 101 }), { ...colonyRow, bodyId: null }), m.fs.compareBase(fleetRow({ orbitBodyId: null }), colonyRow), m.fs.compareBase(fleetRow({ orbitBodyId: 101, assignedPopulationId: null }), colonyRow)]
    const on = [m.fs.compareBase(fleetRow({ orbitBodyId: 100, assignedPopulationId: null }), colonyRow), m.fs.compareBase(fleetRow({ orbitBodyId: null, assignedPopulationId: 10 }), { ...colonyRow, bodyId: null })]
    const off = m.fs.compareBase(fleetRow({ orbitBodyId: 101 }), colonyRow)

    return unknowns.every((result) => result.state === 'unknown' && result.result.status === 'unavailable') && on.every((result) => result.state === 'on') && off.state === 'off' ? true : short([unknowns.map((result) => result.state), on.map((result) => result.state), off.state])
  })

  // ---- rules ----
  add('rules: the rules of the panel are registered and a mark for each can be described', () => {
    const ids = ['fleetStation.onStation', 'fleetStation.distance', 'fleetStation.notes']

    return ids.every((id) => m.provenance.getRule(id) && m.provenance.describeRule(id).length > 0) ? true : short(ids.map((id) => m.provenance.getRule(id)))
  })

  return statements
}

// ---------- the panel ----------

const treeOf = (node) => {
  const found = []
  const visit = (entry) => {
    if (Array.isArray(entry)) {
      entry.forEach(visit)
    } else if (entry && typeof entry === 'object') {
      found.push(entry)
      visit(entry.children)
    }
  }

  visit(node)

  return found
}

// The text a record of a render holds, its children's included.
const textOf = (node) => {
  if (Array.isArray(node)) {
    return node.map(textOf).join('')
  }

  if (node && typeof node === 'object') {
    return textOf(node.children)
  }

  return typeof node === 'string' ? node : ''
}

const attrsOf = (node) => (node && node.data && node.data.attrs) || {}

const marksIn = (nodes) => treeOf(nodes).filter((node) => node.tag === 'provenance-mark').map((node) => attrsOf(node))

// What a compiled template renders for a mounted instance: the render function of the component's own template runs with the instance as its scope. Each element it creates is a record { tag, data, children }; the scoped slots are functions of the record of the table, to be called with a row.
const rendered = (componentText, vm) => {
  const { code } = compiled(componentText)
  const render = require('vm').runInNewContext(`${code.replace(/export \{[^}]*\}\s*$/, '')}\nrender`, {})
  const tags = []
  const texts = []
  const make = (tag, data, children) => {
    const hasData = !Array.isArray(data)

    tags.push(tag)

    return { tag, data: (hasData ? data : null) || {}, children: (hasData ? children : data) || [] }
  }
  const helpers = { _self: { _c: make }, _l: (list, each) => (list || []).map(each), _v: (text) => text, _s: (value) => { texts.push(String(value)); return String(value) }, _e: () => null, _u: (slots) => Object.fromEntries(slots.map((slot) => [slot.key, slot.fn])), _m: () => null }
  const tree = render.call(new Proxy(vm, { get: (target, key) => (key in helpers ? helpers[key] : target[key]) }))

  return { tags, texts, tree }
}

const READY = { loading: false, failed: '', error: '' }

const panel = (ctx) => {
  const { m, options, componentText } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const ast = templateAst(componentText)
  const mount = (data = {}) => instantiate(options, { $store: STORE, data: { state: READY, view: null, repository: null, repositoryError: null, scope: null, context: null, database: null, gameId: GAME, raceId: RACE, ...data } })

  // The panel as a page gives it its props from a save: the view, the context, the repository and the scope.
  const live = async (save = SAVE(), { notes = null, away = false } = {}) => {
    const w = world(m)
    const where = scope()
    const context = await open(m, save, where)

    await kept(m, w, where, context, notes || {})

    const source = away ? edited(save, (copy) => { Object.assign(found(copy.fleets, 30), { orbit: 101, x: 5000, y: 0 }) }) : save
    const { ctx, read, shown, orders } = await readOn(m, w, source, where)
    const view = { ...shown, notes: read.notes, error: read.error, systems: ctx.systems, problems: [] }

    return { w, where, context: ctx, view, read, orders, vm: mount({ view, repository: w.repo, scope: where, context: ctx }) }
  }
  const slotsOf = (tree) => (treeOf(tree).find((node) => node.tag === 'v-data-table') || { data: {} }).data.scopedSlots || {}
  const regionOf = (nodes, name) => treeOf(nodes).filter((node) => name in attrsOf(node))
  const expandedOf = (made, row) => slotsOf(rendered(componentText, made.vm).tree)['expanded-item']({ headers: [], item: row })

  add('component: the template compiles', () => {
    const errors = templateErrors(componentText)

    return errors.length ? short(errors) : true
  })
  add('component: the panel names what it is for in every state it renders, in a sentence with no figure that changes', async () => {
    const made = await live()
    const states = [
      mount({ state: { loading: true, failed: '', error: '' } }),
      mount({ state: { loading: false, failed: 'the saved orders', error: 'boom' } }),
      mount({ view: { ...made.view, error: { message: 'refused' } } }),
      mount({ view: made.view, repositoryError: 'no store' }),
      mount({ view: made.view, scope: null }),
      made.vm,
    ]
    const summaries = states.map((vm) => {
      const [root] = [rendered(componentText, vm).tree].flat()

      return { root, summary: attrsOf(root)['data-summary'] }
    })

    const figuresOf = (summary) => (typeof summary === 'string' ? (summary.match(/\d+(?:[.,]\d+)*/g) || []).join(' ') : null)

    return summaries.every(({ root, summary }) => root.tag === 'v-card' && String(root.data.staticClass).split(' ').includes('panel') && typeof summary === 'string' && summary.trim().length > 0 && !PRONOUNS.test(summary)) && new Set(summaries.map(({ summary }) => figuresOf(summary))).size === 1 ? true : short(summaries.map(({ summary }) => summary))
  })
  add('component: the note, the location against it and the saved orders are three regions of a row, one each, and each holds its own and not the others\'', async () => {
    const made = await live(SAVE(), { notes: { note: KEY_NOTE } })
    const row = rowOf(made.view, 30)
    const expanded = expandedOf(made, row)
    const names = ['data-station-intent', 'data-station-location', 'data-station-orders']
    const regions = names.map((name) => regionOf(expanded, name))
    const texts = regions.map(([node]) => textOf(node))
    const nested = regions.flatMap(([node]) => names.filter((name) => regionOf(node.children, name).length > 0))

    return regions.every((nodes) => nodes.length === 1) && nested.length === 0 && texts[0].includes(KEY_NOTE) && texts[0].includes('Earth') && !texts[0].includes('ORDER-MARKER') && texts[1].includes('Sol') && !texts[1].includes(KEY_NOTE) && !texts[1].includes('ORDER-MARKER') && texts[2].includes('ORDER-MARKER') && !texts[2].includes(KEY_NOTE) ? true : short(texts)
  })
  add('component: every comparison, distance and count shown has a provenance mark bound to its result or its rule', async () => {
    const made = await live(SAVE(), { away: true })
    const row = rowOf(made.view, 30)
    const rendering = rendered(componentText, made.vm)
    const slots = slotsOf(rendering.tree)
    const station = marksIn(slots['item.stationStatus']({ item: row }))
    const base = marksIn(slots['item.baseStatus']({ item: row }))
    const expanded = expandedOf(made, row)
    const compares = regionOf(expanded, 'data-station-compare')
    const head = marksIn(rendering.tree).filter((mark) => mark.rule === 'fleetStation.notes')
    const distances = marksIn(expanded).filter((mark) => mark.result && mark.result.rule && mark.result.rule.id === 'fleetStation.distance')

    return station.length === 1 && station[0].result === row.location.station.result && base.length === 1 && base[0].result === row.location.base.result && compares.length === 2 && compares.every((node) => marksIn(node).length >= 1) && head.length >= 1 && distances.length === 1 ? true : short([station.length, base.length, compares.length, head.length, distances.length])
  })
  add('component: a fleet with no note shows no figure and no comparison, only its place and its saved orders', async () => {
    const made = await live(SAVE(), { notes: { fleet: 30 } })
    const row = rowOf(made.view, 31)
    const slots = slotsOf(rendered(componentText, made.vm).tree)
    const expanded = expandedOf(made, row)

    return row.entry === null && marksIn(slots['item.stationStatus']({ item: row })).length === 0 && regionOf(expanded, 'data-station-compare').length === 0 && regionOf(expanded, 'data-station-no-note').length === 1 && regionOf(expanded, 'data-station-checklist').length === 0 ? true : short([regionOf(expanded, 'data-station-no-note').length])
  })
  add('component: a read that is out or has failed shows the progress or the failure and neither the table, the count nor a note', async () => {
    const made = await live()
    const failed = rendered(componentText, mount({ state: { loading: false, failed: 'the saved orders', error: 'boom' } }))
    const loading = rendered(componentText, mount({ state: { loading: true, failed: '', error: '' } }))
    const loaded = rendered(componentText, made.vm)
    const hidden = (made2) => made2.tags.includes('load-state') && !made2.tags.includes('v-data-table') && regionOf(made2.tree, 'data-station-count').length === 0 && marksIn(made2.tree).length === 0

    return hidden(failed) && hidden(loading) && loaded.tags.includes('v-data-table') && !loaded.tags.includes('load-state') && regionOf(loaded.tree, 'data-station-count').length === 1 ? true : short([failed.tags.length, loading.tags.length])
  })
  add('component: notes under review, archived and not checked are listed apart with the names they had, with no comparison and an action that fits', async () => {
    const w = world(m)
    const save = SAVE()
    const context = await open(m, save)

    await kept(m, w, scope(), context)
    await kept(m, w, scope(), context, { fleet: 31, station: ['body', 200], base: null })

    const reissued = edited(save, (copy) => {
      Object.assign(found(copy.fleets, 30), { name: '9th Fleet', created: 9000 })
      copy.fleets = copy.fleets.filter((row) => row.id !== 31)
    })
    const { ctx, read, shown } = await readOn(m, w, reissued)
    const noFleets = await readOn(m, w, save, scope(), { failing: ['select FCT_Fleet.FleetID'] })
    const view = { ...shown, unchecked: noFleets.shown.unchecked, notes: read.notes, error: null, systems: ctx.systems, problems: [] }
    const vm = mount({ view, repository: w.repo, scope: scope(), context: ctx })
    const { tree } = rendered(componentText, vm)
    const review = regionOf(tree, 'data-station-review-note')
    const archived = regionOf(tree, 'data-station-archived-note')
    const unchecked = regionOf(tree, 'data-station-unchecked-note')

    return review.length === 1 && textOf(review[0]).includes('1st Fleet') && textOf(review[0]).includes('9th Fleet') && regionOf(review, 'data-station-attach').length === 1 && archived.length === 1 && textOf(archived[0]).includes('2nd Fleet') && textOf(archived[0]).includes('Proxima b') && regionOf(archived, 'data-station-attach').length === 0 && unchecked.length === 2 && regionOf(tree, 'data-station-compare').length === 0 ? true : short([review.length, archived.length, unchecked.length])
  })
  add('component: a note made after the open save is listed apart with an action to use it in this save, with no comparison, no checklist and no row of its own', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const earlier = scope('b1', RACE, 'c1', 50000)
    const { ctx, read, shown } = await readOn(m, w, save, earlier)
    const view = { ...shown, notes: read.notes, error: null, systems: ctx.systems, problems: [] }
    const made = { vm: mount({ view, repository: w.repo, scope: earlier, context: ctx }) }
    const { tree } = rendered(componentText, made.vm)
    const ahead = regionOf(tree, 'data-station-ahead-note')
    const expanded = expandedOf(made, rowOf(view, 30))

    return ahead.length === 1 && textOf(ahead[0]).includes('1st Fleet') && regionOf(ahead, 'data-station-rebase').length === 1 && regionOf(tree, 'data-station-compare').length === 0 && regionOf(expanded, 'data-station-no-note').length === 1 && regionOf(expanded, 'data-station-checklist').length === 0 && regionOf(tree, 'data-station-count').length === 1 && textOf(regionOf(tree, 'data-station-count')[0]).includes('1') ? true : short([ahead.length, regionOf(expanded, 'data-station-no-note').length])
  })
  add('component: using a note made after the open save writes through the repository and makes it current', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(m, w, scope(), await open(m, save))

    const earlier = scope('b1', RACE, 'c1', 50000)
    const { ctx, read, shown } = await readOn(m, w, save, earlier)
    const vm = mount({ view: { ...shown, notes: read.notes, error: null, systems: ctx.systems, problems: [] }, repository: w.repo, scope: earlier, context: ctx })

    await vm.rebase(shown.ahead[0])

    return (await readOn(m, w, save, earlier)).shown.ahead.length === 0 && vm.messageType === 'success' ? true : short([vm.message, vm.messageType])
  })
  add('component: notes of one fleet that overlap are listed with an action to delete each, the fleet is flagged, and none is attached to it', async () => {
    const w = world(m)
    const save = SAVE()
    const first = await kept(m, w, scope('b1'), await open(m, save, scope('b1')), { note: 'one' })

    await kept(m, w, scope('b2'), await open(m, save, scope('b2')), { note: 'two' })
    w.repo.update(scope('b1'), first.uuid, first.revision, { policy: 'campaign' })

    const { ctx, read, shown } = await readOn(m, w, save, scope('b2'))
    const view = { ...shown, notes: read.notes, error: null, systems: ctx.systems, problems: [] }
    const made = { vm: mount({ view, repository: w.repo, scope: scope('b2'), context: ctx }) }
    const rendering = rendered(componentText, made.vm)
    const listed = regionOf(rendering.tree, 'data-station-overlapping-note')
    const chips = regionOf(slotsOf(rendering.tree)['item.flags']({ item: rowOf(view, 30) }), 'data-station-overlap-chip')

    return listed.length === 2 && listed.every((node) => regionOf(node, 'data-station-delete').length === 1) && chips.length === 1 && regionOf(expandedOf(made, rowOf(view, 30)), 'data-station-no-note').length === 1 ? true : short([listed.length, chips.length])
  })
  add('component: a kind of object that could not be read is listed with a Retry that asks the page to read again', async () => {
    const made = await live()
    const vm = mount({ view: { ...made.view, problems: [{ key: 'colony', message: 'down' }] }, repository: made.w.repo, scope: made.where, context: made.context })
    const { tree } = rendered(componentText, vm)
    const retry = regionOf(tree, 'data-station-problem-retry')

    return regionOf(tree, 'data-station-problem').length === 1 && retry.length === 1 && typeof (retry[0].data.on || {}).click === 'function' ? true : short([retry.length, retry[0] && retry[0].data])
  })
  add('component: a saved order that has arrived is marked arrived by the structured state of its list item, one that has not or whose arrival is not recorded is not, and a last order that names the station says only that, with a minimum distance told apart from none', async () => {
    const stateOf = async (extra, minDistance = 0) => {
      const made = await live(edited(SAVE(), (copy) => { copy.orders = [order(1, 30, 'ORDER-MARKER load', 2, 100, { ...extra, minDistance })] }))
      const region = regionOf(expandedOf(made, rowOf(made.view, 30)), 'data-station-orders')[0]
      const items = treeOf(region).filter((node) => 'data-station-order-arrived' in attrsOf(node))

      return { items, state: items.length === 1 ? attrsOf(items[0])['data-station-order-arrived'] : null, heads: textOf(regionOf(region, 'data-station-heads')[0]) }
    }
    const arrived = await stateOf({ arrived: 1 })
    const underway = await stateOf({ arrived: 0 })
    const unrecorded = await stateOf({ arrived: null })
    const set = await stateOf({ arrived: 1 }, 5000)
    const unknown = await stateOf({ arrived: 1 }, null)
    const states = [arrived.state, underway.state, unrecorded.state]

    return states.every((state) => typeof state === 'string' && state.length > 0) && arrived.state !== underway.state && unrecorded.state === underway.state && new Set([arrived.heads, set.heads, unknown.heads]).size === 3 && arrived.heads.length > 0 ? true : short([states, arrived.heads, set.heads, unknown.heads])
  })
  add('component: a fleet on station by position while its own orbit is null is shown with no left-behind warning, no fixed point and no orbit step, and the known states are shown as they are', async () => {
    const stateOf = async (change, station) => {
      const made = await live(edited(SAVE(), (copy) => { change(copy) }), { notes: { station, base: null } })
      const row = rowOf(made.view, 30)
      const expanded = expandedOf(made, row)
      const steps = treeOf(regionOf(expanded, 'data-station-checklist')).filter((node) => 'data-station-step' in attrsOf(node)).map((node) => attrsOf(node)['data-station-step'])

      return { on: row.location.station.state, left: regionOf(expanded, 'data-station-not-followed').length, fixed: regionOf(expanded, 'data-station-fixed').length, unknown: regionOf(expanded, 'data-station-movement-unknown').length, steps }
    }
    const atBody = (orbit) => (copy) => { Object.assign(found(copy.fleets, 30), { orbit, x: 1000, y: 2000 }) }
    const atPoint = (tie) => (copy) => {
      Object.assign(found(copy.fleets, 30), { orbit: 0, x: 3000, y: 3000 })
      found(copy.waypoints, 61).orbit = tie
    }
    const noOrbit = await stateOf(atBody(null), ['body', 100])
    const left = await stateOf(atBody(0), ['body', 100])
    const fixed = await stateOf(atPoint(0), ['waypoint', 61])

    return noOrbit.on === 'on' && noOrbit.unknown === 1 && noOrbit.left === 0 && noOrbit.fixed === 0 && !noOrbit.steps.includes('orbit') && left.on === 'on' && left.left === 1 && left.unknown === 0 && left.steps.includes('orbit') && fixed.on === 'on' && fixed.fixed === 1 && fixed.left === 0 && fixed.unknown === 0 ? true : short([noOrbit, left, fixed])
  })
  add('component: the last saved order is told as naming the station, naming another destination or not known to do either, and a destination kind or ID the save leaves null is never told as another destination', async () => {
    const headsOf = async (destinationType, destinationId) => {
      const made = await live(edited(SAVE(), (copy) => { copy.orders = [order(1, 30, 'ORDER-MARKER load', destinationType, destinationId)] }))
      const region = regionOf(expandedOf(made, rowOf(made.view, 30)), 'data-station-orders')[0]
      const heads = regionOf(region, 'data-station-heads')

      return { count: heads.length, state: heads.length === 1 ? attrsOf(heads[0])['data-station-heads'] : null, text: heads.length === 1 ? textOf(heads[0]) : '' }
    }
    const station = await headsOf(2, 100)
    const other = await headsOf(2, 101)
    const noKind = await headsOf(null, 100)
    const noId = await headsOf(2, null)
    const mismatch = await headsOf(null, 101)

    return [station, other, noKind, noId, mismatch].every((one) => one.count === 1) && station.state === 'station' && other.state === 'other' && noKind.state === 'unknown' && noId.state === 'unknown' && mismatch.state === 'other' && new Set([station.text, other.text, noKind.text]).size === 3 ? true : short([station, other, noKind, noId, mismatch])
  })
  add('component: a body picker read that failed is retried from the form with a Retry that keeps the draft and the selected system, and the bodies are there once the read succeeds', async () => {
    const made = await live()
    const failing = ['select FCT_SystemBody.']
    const vm = mount({ view: made.view, repository: made.w.repo, scope: made.where, context: await open(m, SAVE(), made.where, { bodyIds: [100] }), database: fakeSave(SAVE(), { failing }) })

    vm.startNew()
    vm.draft.stationMode = 'body'
    vm.draft.stationSystem = 2
    vm.draft.note = 'DRAFT-MARKER'
    await vm.loadPicker(2)

    const retries = regionOf(rendered(componentText, vm).tree, 'data-station-picker-retry')
    const click = retries.length === 1 ? (retries[0].data.on || {}).click : null
    const failedChoices = vm.stationChoicesList.length

    failing.length = 0

    if (typeof click === 'function') {
      await click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    const after = regionOf(rendered(componentText, vm).tree, 'data-station-picker-retry')

    return retries.length === 1 && typeof click === 'function' && failedChoices === 0 && vm.draft.note === 'DRAFT-MARKER' && vm.draft.stationSystem === 2 && vm.draft.stationMode === 'body' && vm.pickerError === '' && after.length === 0 && vm.stationChoicesList.some((choice) => choice.id === 200) ? true : short([retries.length, typeof click, failedChoices, vm.pickerError, vm.draft, vm.stationChoicesList.length])
  })
  add('component: the count of notes, with its mark, is shown only where the notes were read: not while the notes cannot be read, the records are not available or the campaign is not settled', async () => {
    const made = await live()
    const withScope = { view: made.view, repository: made.w.repo, scope: made.where, context: made.context }
    const shownIn = (vm) => {
      const { tree } = rendered(componentText, vm)

      return { chips: regionOf(tree, 'data-station-count').length, marks: marksIn(tree).filter((mark) => mark.rule === 'fleetStation.notes').length }
    }
    const loaded = shownIn(mount(withScope))
    const hidden = [shownIn(mount({ ...withScope, repositoryError: 'no store' })), shownIn(mount({ ...withScope, scope: null })), shownIn(mount({ ...withScope, view: { ...made.view, error: { message: 'refused' } } })), shownIn(mount({ state: { loading: true, failed: '', error: '' } }))]

    return loaded.chips === 1 && loaded.marks === 1 && hidden.every((one) => one.chips === 0 && one.marks === 0) ? true : short([loaded, hidden])
  })
  add('component: the checklist is the steps of the utility, one element for each, with no link and no explainer', async () => {
    const made = await live(SAVE(), { away: true })
    const row = rowOf(made.view, 30)
    const expanded = expandedOf(made, row)
    const list = regionOf(expanded, 'data-station-checklist')
    const steps = treeOf(list).filter((node) => 'data-station-step' in attrsOf(node)).map((node) => attrsOf(node)['data-station-step'])
    const links = treeOf(list).filter((node) => ['page-link', 'router-link', 'a'].includes(node.tag))

    return list.length === 1 && same(steps, m.fs.checklistOf(row).map((step) => step.key)) === true && steps.length >= 2 && links.length === 0 ? true : short([steps, links.length])
  })
  add('component: nothing the panel says addresses a person, and every step, comparison and verdict has words', async () => {
    const made = await live(SAVE(), { away: true })
    const row = rowOf(made.view, 30)
    const statics = staticTextOf(ast).join(' ')
    const spoken = [
      ...m.fs.checklistOf(row).map((step) => made.vm.stepText(step)),
      made.vm.stepText({ key: 'repick', role: 'station', target: 'Earth', reason: 'gone' }),
      made.vm.stepText({ key: 'repick', role: 'base', target: 'Earth', reason: 'review' }),
      made.vm.stepText({ key: 'orbit', role: 'station', target: 'Earth' }),
      ...['on', 'off', 'unknown'].map((state) => made.vm.comparisonText({ state, basis: 'orbit', where: 'other-orbit' })),
      ...['held', 'review', 'gone', 'unread'].map((state) => made.vm.verdictText({ verdict: { state, basis: 'confirmed' } })),
      made.vm.resemblanceText({ sameName: true, classesOverlap: false }),
    ]

    return !PRONOUNS.test(statics) && spoken.every((text) => typeof text === 'string' && text.trim().length > 0 && !PRONOUNS.test(text)) ? true : short([spoken.filter((text) => PRONOUNS.test(text)), PRONOUNS.exec(statics)])
  })
  add('component: a form filled in for another campaign, race or branch is refused and nothing is written', async () => {
    const made = await live(SAVE(), { notes: { fleet: 30 } })
    const vm = mount({ view: made.view, repository: made.w.repo, scope: made.where, context: made.context })

    vm.startNew()
    vm.draft.fleetPick = { id: 31, row: made.context.objects.fleet.get(31) }
    vm.draft.scopeKey = 'c2|7|b1'
    await vm.save()

    return made.w.repo.list(made.where, { kind: m.fs.STATION_KIND }).length === 1 && vm.message.length > 0 && vm.draft.open === false ? true : short([vm.message, vm.draft.open])
  })
  add('component: a note is kept from the form for a fleet that has none, with its station and base picked from the save', async () => {
    const made = await live(SAVE(), { notes: { fleet: 30 } })
    const vm = mount({ view: made.view, repository: made.w.repo, scope: made.where, context: made.context })

    vm.startNew()
    vm.draft.fleetPick = { id: 31, row: made.context.objects.fleet.get(31) }
    vm.draft.stationMode = 'body'
    vm.draft.stationPick = { id: 200, row: made.context.objects.body.get(200) }
    vm.draft.baseMode = 'colony'
    vm.draft.basePick = { id: 11, row: made.context.objects.colony.get(11) }
    vm.draft.note = 'hold here'
    await vm.save()

    const stored = made.w.repo.list(made.where, { kind: m.fs.STATION_KIND }).find((item) => item.payload.fleet.id === 31)

    return stored && stored.payload.station.id === 200 && stored.payload.base.id === 11 && stored.payload.note === 'hold here' && vm.message.length > 0 && vm.messageType === 'success' ? true : short([stored && stored.payload, vm.message])
  })
  add('component: the form offers the fleets that have no note and the bodies of the system picked, never the fleets with one', async () => {
    const made = await live(SAVE(), { notes: { fleet: 30 } })
    const vm = mount({ view: made.view, repository: made.w.repo, scope: made.where, context: made.context })

    vm.startNew()
    vm.draft.stationMode = 'body'
    vm.draft.stationSystem = 1

    const withBodies = made.context
    const bodyVm = mount({ view: made.view, repository: made.w.repo, scope: made.where, context: withBodies, pickerBodies: new Map([[101, withBodies.objects.body.get(101)]]) })

    bodyVm.startNew()
    bodyVm.draft.stationMode = 'body'
    bodyVm.draft.stationSystem = 1

    return same(vm.fleetChoices.map((choice) => choice.id), [31]) === true && bodyVm.stationChoicesList.every((choice) => choice.row.systemId === 1) && bodyVm.stationChoicesList.length >= 1 ? true : short([vm.fleetChoices.map((choice) => choice.id), bodyVm.stationChoicesList.map((choice) => choice.id)])
  })
  add('component: a stale edit is not written, offers what is stored, and is written over only when asked', async () => {
    const made = await live(SAVE(), { notes: { note: 'first' } })
    const entry = made.view.rows.find((row) => row.entry).entry
    const vm = mount({ view: made.view, repository: made.w.repo, scope: made.where, context: made.context })

    vm.startEdit(entry)
    vm.draft.note = 'mine'

    await m.fs.saveStation(made.w.repo, made.where, { entry, note: 'elsewhere', context: made.context })
    await vm.save(false)

    const stored = () => made.w.repo.list(made.where, { kind: m.fs.STATION_KIND })[0].payload.note
    const refused = vm.conflict !== null && vm.conflict.note === 'elsewhere' && stored() === 'elsewhere'

    await vm.save(true)

    return refused && stored() === 'mine' && vm.conflict === null ? true : short([refused, stored(), vm.conflict])
  })
  add('component: a delete asks twice and removes only the note it names', async () => {
    const made = await live(SAVE(), { notes: { note: 'one' } })
    const entry = made.view.rows.find((row) => row.entry).entry
    const vm = mount({ view: made.view, repository: made.w.repo, scope: made.where, context: made.context })
    const before = made.w.repo.list(made.where, { kind: m.fs.STATION_KIND }).length

    await vm.remove(entry)

    return before === 1 && made.w.repo.list(made.where, { kind: m.fs.STATION_KIND }).length === 0 && vm.messageType === 'success' ? true : short([before, vm.message])
  })
  add('component: confirming a station or a fleet under review writes through the repository and reports it', async () => {
    const w = world(m)
    const save = SAVE()
    const context = await open(m, save)

    await kept(m, w, scope(), context)

    const reissued = edited(save, (copy) => { Object.assign(found(copy.fleets, 30), { name: '9th Fleet', created: 9000 }) })
    const { ctx, read, shown } = await readOn(m, w, reissued)
    const vm = mount({ view: { ...shown, notes: read.notes, error: null, systems: ctx.systems, problems: [] }, repository: w.repo, scope: scope(), context: ctx })

    await vm.confirm(shown.review[0], 'fleet')

    const after = m.fs.readStations(w.repo, scope(), ctx)

    return after.entries[0].fleetState === 'held' && vm.messageType === 'success' ? true : short([after.entries[0].fleetState, vm.message])
  })

  return statements
}

// ---------- the page ----------

const asyncNamesOf = (options) => [...(options.mixins || []).flatMap(asyncNamesOf), ...Object.keys(options.asyncComputed || {})]
const READS = new WeakMap()

// The reads of the page that are tracked (their loadErrors entry is written when each settles), found by running each async read against a database that fails: what the page declares, not what its text says.
const readsOf = async (ctx) => {
  if (!READS.has(ctx)) {
    const failing = { query: async () => { throw new Error('boom') } }
    const vm = instantiate(ctx.livePageOptions, { $store: PAGE_STORE, database: failing, GameID: GAME, RaceID: RACE, data: { loadErrors: {} } })
    const tracked = []

    for (const key of new Set(asyncNamesOf(ctx.livePageOptions))) {
      try {
        await vm.runAsync(key)
      } catch (error) {
        // a failed read is still a tracked one
      }

      if (vm.loadErrors[key] !== undefined) {
        tracked.push(key)
      }
    }

    READS.set(ctx, tracked)
  }

  return READS.get(ctx)
}

// The reads the mixin declares, each of which the panel waits on: the tracked ones among its async reads.
const stationReadsOf = async (ctx) => (await readsOf(ctx)).filter((key) => key in (ctx.mixinOptions.asyncComputed || {}))

// The nearest element of a compiled template, the element itself included, that is a branch of a v-if chain.
const ancestorOf = (element) => {
  let node = element

  while (node && !(node.if || node.elseif || node.else)) {
    node = node.parent
  }

  return node
}

const page = (ctx) => {
  const { pageText, pageOptions, mixinText } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const pageAst = templateAst(pageText)
  const mounted = elementsOf(pageAst).filter((element) => element.tag === 'fleet-stations')
  const liveMount = (data = {}, extra = {}) => instantiate(ctx.livePageOptions, { $store: PAGE_STORE, database: null, GameID: GAME, RaceID: RACE, data, ...extra })

  add('page: the template compiles', () => {
    const errors = templateErrors(pageText)

    return errors.length ? short(errors) : true
  })
  add('page: the panel is mounted once with every value bound to what the page works out, and its retry and its changes are the page\'s own handlers', () => {
    const { props, events } = mounted.length ? bindingsOf(mounted[0]) : { props: {}, events: {} }
    const vm = liveMount({ stationRecords: { repository: null, error: 'none' } })
    const wanted = { state: 'stationState', view: 'stationView', repository: 'stationRepository', 'repository-error': 'stationRepositoryError', scope: 'stationScope', context: 'stationContext' }
    const wrong = Object.entries(wanted).filter(([prop, name]) => props[prop] === undefined || (evaluate(props[prop], vm) !== vm[name] && short(evaluate(props[prop], vm)) !== short(vm[name])))
    const updates = []
    const retrying = liveMount({ loadErrors: { stationObjects: 'down' }, $asyncComputed: { stationObjects: { update: () => updates.push('stationObjects') } } })
    const retry = events.retry === undefined ? null : evaluate(events.retry, retrying)
    const changing = liveMount({})
    const changed = events.changed === undefined ? null : evaluate(events.changed, changing)

    if (typeof retry === 'function') {
      retry()
    }

    if (typeof changed === 'function') {
      changed()
    }

    return mounted.length === 1 && !wrong.length && props.database !== undefined && props['game-id'] !== undefined && props['race-id'] !== undefined && evaluate(props['game-id'], vm) === GAME && evaluate(props['race-id'], vm) === RACE && same(updates, ['stationObjects']) === true && changing.stationRevision === 1 && 'FleetStations' in pageOptions.components ? true : short([mounted.length, wrong, updates, changing.stationRevision, Object.keys(pageOptions.components)])
  })
  add('page: the panel is shown in a view of its own, behind the ready gate, and in no other, and the view is one the page keeps', () => {
    const vm = (view) => liveMount({ view })
    const chain = elementsOf(pageAst).find((element) => (element.ifConditions || []).length > 1 && element.ifConditions.some((branch) => branch.block === ancestorOf(mounted[0])))
    const shownIn = (view) => {
      const hit = chain ? chain.ifConditions.find((branch) => branch.exp === undefined || evaluate(branch.exp, vm(view))) : null

      return Boolean(hit) && hit.block === ancestorOf(mounted[0])
    }
    const gates = []

    for (let node = mounted[0]; node; node = node.parent) {
      if (node.if && node !== chain) {
        gates.push(node.if)
      }
    }

    const fields = ctx.persisted || {}
    const views = ['fuel', 'maintenance', 'stations']
    const gated = (ready) => gates.every((expression) => !!evaluate(expression, liveMount({ loadErrors: ready }, {})))
    const buttons = elementsOf(pageAst).filter((element) => element.tag === 'v-btn' && element.attrsMap.value === 'stations')

    return mounted.length === 1 && chain && same(views.filter(shownIn), ['stations']) === true && fields.view && fields.view.valid('stations') === true && buttons.length === 1 && gates.length > 0 && gated({}) === false ? true : short([views.filter(shownIn), gates, buttons.length, fields.view && fields.view.valid('stations')])
  })
  add('page: the reads of the panel are tracked reads, and the tracked key, the read\'s name and the label of each are one string', async () => {
    const tracked = await stationReadsOf(ctx)
    const labels = objectKeys(mixinText, 'STATION_LABELS')
    const pageLabels = objectKeys(scriptOf(pageText), 'INPUT_LABELS') || []
    const declared = Object.keys(ctx.mixinOptions.asyncComputed)
    const labelled = labels && pageLabels.includes('...STATION_LABELS')

    return labels && labels.length >= 2 && same([...tracked].sort(), [...labels].sort()) === true && labelled && declared.filter((key) => !tracked.includes(key)).every((key) => !/object|bodies|orders/i.test(key)) ? true : short([tracked, labels, pageLabels, declared])
  })
  add('page: the reads of the panel wait for a database, a game and a race, and return nothing for a save that is not there', async () => {
    const results = []

    for (const key of await stationReadsOf(ctx)) {
      for (const data of [{ database: null, GameID: GAME, RaceID: RACE }, { database: { query: async () => { throw new Error('asked') } }, GameID: null, RaceID: RACE }, { database: { query: async () => { throw new Error('asked') } }, GameID: GAME, RaceID: null }]) {
        const vm = instantiate(ctx.livePageOptions, { $store: PAGE_STORE, ...data, data: { loadErrors: {} } })

        results.push([key, await vm.runAsync(key)])
      }
    }

    return results.length >= 6 && results.every(([, value]) => value === null) ? true : short(results)
  })

  return statements
}

// ---------- the reads that hold nothing back ----------

const optional = (ctx) => {
  const { m } = ctx
  const statements = []
  const add = (name, test) => statements.push([name, test])
  const coreOf = async () => (await readsOf(ctx)).filter((key) => !(key in ctx.mixinOptions.asyncComputed))
  const stationOf = () => stationReadsOf(ctx)
  const settledOf = async () => Object.fromEntries((await coreOf()).map((key) => [key, null]))
  const failing = { query: async () => { throw new Error('boom') } }
  const mountPage = async (data = {}, database = failing) => instantiate(ctx.livePageOptions, { $store: PAGE_STORE, database, GameID: GAME, RaceID: RACE, data: { loadErrors: await settledOf(), ...data } })
  const stateOf = (vm) => vm.stationState
  const withRecords = async (save = SAVE()) => {
    const w = world(m)
    const context = await open(m, save)

    await kept(m, w, scope(), context)

    return { w, records: { repository: w.repo, error: null } }
  }

  add('optional: the other reads in, the page is ready while the reads of the panel are in flight, and the panel is loading', async () => {
    const vm = await mountPage()

    return vm.ready === true && vm.failedInputs.length === 0 && same(stateOf(vm), { loading: true, failed: '', error: '' }) === true && vm.stationView === null ? true : short([vm.ready, stateOf(vm)])
  })
  add('optional: a rejected read of the panel leaves the page ready with no failed input, and the panel reports the failure with its message', async () => {
    const results = []

    for (const key of await stationOf()) {
      const vm = await mountPage({ stationRecords: (await withRecords()).records })
      let thrown = null

      try {
        await vm.runAsync(key)
      } catch (error) {
        thrown = error.message
      }

      const state = stateOf(vm)

      results.push(thrown === 'boom' && vm.ready === true && vm.inputsLoaded === true && vm.failedInputs.length === 0 && vm.failedInputsText === '' && state.loading === false && state.error === 'boom' && state.failed.length > 0 && vm.loadErrors[key] === 'boom' && vm.stationView === null ? true : short([key, thrown, vm.ready, vm.failedInputs, state]))
    }

    return results.length >= 3 && results.every((result) => result === true) ? true : short(results)
  })
  add('optional: a failure of another read still holds the page back, and is not the panel\'s', async () => {
    const [first] = await coreOf()
    const vm = await mountPage({ loadErrors: { ...await settledOf(), [first]: 'down' } })

    return vm.ready === false && same(vm.failedInputs, [first]) === true && stateOf(vm).failed === '' ? true : short([vm.ready, vm.failedInputs, stateOf(vm)])
  })
  add('optional: the reads of the panel succeeding leave the panel neither loading nor failed, with the fleets listed and the notes read for the race and save shown', async () => {
    const { records } = await withRecords()
    const database = fakeSave(SAVE())
    const vm = await mountPage({ stationRecords: records }, database)

    for (const key of await stationOf()) {
      await vm.runAsync(key)
    }

    const view = vm.stationView

    return vm.ready === true && same(stateOf(vm), READY) === true && view && view.rows.length === 2 && view.rows.filter((row) => row.entry).length === 1 && view.systems.length === 2 && database.sent.every(({ sql }) => /^\s*select\b/i.test(sql)) ? true : short([vm.ready, stateOf(vm), view && view.rows.length])
  })
  add('optional: the retry reads again only the reads of the panel that failed', async () => {
    const updates = []
    const [first] = await coreOf()
    const keys = [...await coreOf(), ...await stationOf()]
    const $asyncComputed = Object.fromEntries(keys.map((key) => [key, { update: () => updates.push(key) }]))
    const stations = await stationOf()

    ;(await mountPage({ $asyncComputed })).retryStations()
    ;(await mountPage({ $asyncComputed, loadErrors: { ...await settledOf(), [stations[1]]: 'boom', [first]: 'down' } })).retryStations()

    return same(updates, [stations[1]]) === true ? true : short(updates)
  })
  add('optional: a read made for another race, game or save is not used for the one shown', async () => {
    const { records } = await withRecords()
    const database = fakeSave(SAVE())
    const vm = await mountPage({ stationRecords: records }, database)

    for (const key of await stationOf()) {
      await vm.runAsync(key)
    }

    const loaded = stateOf(vm).loading === false
    const objects = vm.stationObjects
    const orders = vm.stationOrders

    vm.stationObjects = { ...objects, RaceID: RACE + 1 }
    const raceSwitched = stateOf(vm).loading === true && vm.stationContext === null
    vm.stationObjects = { ...objects, database: fakeSave(SAVE()) }
    const saveSwitched = stateOf(vm).loading === true
    vm.stationObjects = objects
    vm.stationOrders = { ...orders, GameID: GAME + 1 }
    const gameSwitched = stateOf(vm).loading === true

    return loaded && raceSwitched && saveSwitched && gameSwitched ? true : short([loaded, raceSwitched, saveSwitched, gameSwitched])
  })
  add('optional: a body the notes name that the read did not ask for reads not checked, never gone, until its own read is in', async () => {
    const { records } = await withRecords()
    const database = fakeSave(SAVE())
    const vm = await mountPage({ stationRecords: records }, database)

    for (const key of await stationOf()) {
      await vm.runAsync(key)
    }

    vm.stationBodies = { ...vm.stationBodies, requested: new Set() }

    const pending = stateOf(vm).loading === true && vm.stationBodiesBundle === null
    const read = vm.stationRead

    return pending && read.entries[0].intent.station.verdict.state === 'unread' && read.entries[0].stale.length === 0 ? true : short([pending, read.entries[0].intent.station.verdict])
  })
  add('optional: a kind of object that failed inside the objects read is retried from the panel, and the retry reads again only then', async () => {
    const { records } = await withRecords()
    const failing = ['from FCT_Population']
    const database = fakeSave(SAVE(), { failing })
    const updates = []
    const keys = [...await coreOf(), ...await stationOf()]
    const $asyncComputed = Object.fromEntries(keys.map((key) => [key, { update: () => updates.push(key) }]))
    const vm = await mountPage({ stationRecords: records, $asyncComputed }, database)

    for (const key of await stationOf()) {
      await vm.runAsync(key)
    }

    const problems = vm.stationView.problems.map((problem) => problem.key)

    vm.retryStations()

    const asked = [...updates]

    failing.length = 0
    await vm.runAsync('stationObjects')
    vm.retryStations()

    return same(problems, ['colony']) === true && same(asked, ['stationObjects']) === true && vm.stationView.problems.length === 0 && same(updates, ['stationObjects']) === true ? true : short([problems, asked, updates, vm.stationView && vm.stationView.problems])
  })
  add('optional: a fleet list that cannot be read fails the read of the panel, while another kind failing leaves the rest listed and is named', async () => {
    const { records } = await withRecords()
    const noFleets = fakeSave(SAVE(), { failing: ['select FCT_Fleet.FleetID'] })
    const vm = await mountPage({ stationRecords: records }, noFleets)
    let thrown = null

    try {
      await vm.runAsync('stationObjects')
    } catch (error) {
      thrown = error.message
    }

    const noColonies = fakeSave(SAVE(), { failing: ['from FCT_Population'] })
    const other = await mountPage({ stationRecords: records }, noColonies)

    for (const key of await stationOf()) {
      await other.runAsync(key)
    }

    return thrown !== null && vm.loadErrors.stationObjects === thrown && other.stationView !== null && other.stationView.problems.length === 1 && other.stationView.problems[0].key === 'colony' && other.stationView.rows.length === 2 ? true : short([thrown, other.stationView && other.stationView.problems])
  })

  return statements
}

// ---------- the saves ----------

const allRows = (raw, sql, params = []) => new Promise((resolve, reject) => raw.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))))
const closeRaw = (raw) => new Promise((resolve) => raw.close(resolve))

const openSave = (file) => new Promise((resolve, reject) => {
  const target = path.resolve(root, file)

  if (!fs.existsSync(target)) {
    resolve(null)

    return
  }

  const raw = new sqlite3.Database(target, sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(raw)))
})

// A database as the loaders ask it: `query(sql, { replacements })` with named parameters, answered with `[rows]`.
const databaseOf = (raw) => ({
  query: async (sql, { replacements = {} } = {}) => {
    const params = Object.fromEntries(Object.entries(replacements).filter(([name]) => sql.includes(`:${name}`)).map(([name, value]) => [`:${name}`, value]))

    return [await allRows(raw, sql, params)]
  },
})

const saveStatements = async (ctx, save) => {
  const { m } = ctx
  const raw = await openSave(save.file)

  if (!raw) {
    return { skipped: true }
  }

  const database = databaseOf(raw)
  const ids = { GameID: save.game, RaceID: save.race }
  const statements = []
  const add = (name, test) => statements.push([`${name.split(':')[0]}:${save.file} ${name.slice(name.indexOf(':') + 1)}`, test])
  const count = async (sql) => (await allRows(raw, sql, [save.game, save.race]))[0].n

  add('save-loaders: the real queries load the race\'s fleets, waypoints (none marked for deletion), colonies and orders, and the counts are the tables\'', async () => {
    const objects = await m.fs.loadStationObjects(database, ids)
    const orders = await m.fs.loadFleetOrders(database, ids)
    const fleets = await count('select count(*) as n from FCT_Fleet where GameID = ? and RaceID = ?')
    const waypoints = await allRows(raw, `select count(*) as n from FCT_Waypoint where GameID = ? and RaceID = ? and WaypointType != ${m.placeData.MARKED_FOR_DELETION}`, [save.game, save.race])
    const colonies = await count('select count(*) as n from FCT_Population where GameID = ? and RaceID = ?')
    const queued = await count('select count(*) as n from FCT_MoveOrders where GameID = ? and RaceID = ?')
    const total = [...orders.values()].reduce((sum, list) => sum + list.length, 0)

    return same(Object.keys(objects.failed), []) === true && objects.objects.fleet.size === fleets && objects.objects.waypoint.size === waypoints[0].n && objects.objects.colony.size === colonies && total === queued ? true : short([objects.failed, objects.objects.fleet.size, fleets, objects.objects.waypoint.size, waypoints[0].n, total, queued])
  })
  add('save-orbit: every fleet in the orbit of a body is on station of that body by the orbit, whatever its coordinates', async () => {
    const objects = await m.fs.loadStationObjects(database, ids)
    const orbiting = [...objects.objects.fleet.values()].filter((row) => row.orbitBodyId > 0)
    const bodies = await m.fs.loadStationBodies(database, { ...ids, bodyIds: [...new Set(orbiting.map((row) => row.orbitBodyId))] })
    const known = orbiting.filter((row) => bodies.has(row.orbitBodyId) && bodies.get(row.orbitBodyId).systemId === row.systemId)
    const wrong = known.filter((row) => {
      const result = m.fs.compareStation(row, bodies.get(row.orbitBodyId))

      return !(result.state === 'on' && result.basis === 'orbit')
    })

    return known.length > 0 && wrong.length === 0 ? true : short([known.length, wrong.slice(0, 3)])
  })
  add('save-reads: a fleet with no creation entry in the save has no creation time and a note on it is not held by evidence', async () => {
    const objects = await m.fs.loadStationObjects(database, ids)
    const undated = [...objects.objects.fleet.values()].filter((row) => row.created === null).length
    const raw0 = await count("select count(*) as n from FCT_Fleet where GameID = ? and RaceID = ? and FleetID not in (select FleetID from FCT_FleetHistory where Description like 'Created on%')")

    return undated === raw0 ? true : short([undated, raw0])
  })

  return { statements, close: () => closeRaw(raw) }
}

// ---------- the planted faults ----------

/* eslint-disable no-template-curly-in-string */
const MUTATIONS = [
  { name: 'the orbit not taken for the identity of a fleet on station', file: U, at: /if \(anchor !== null && fleet\.orbitBodyId === anchor\) \{/, to: () => 'if (false) {', fails: ['orbit'] },
  { name: 'the tolerance taken as inclusive', file: U, at: /km < ON_STATION_KM/, to: () => 'km <= ON_STATION_KM', fails: ['orbit'] },
  { name: 'a fleet at the body by position taken as following it', file: U, at: /(const movement = anchorUnknown \? 'unknown' : anchor === null \? 'fixed' : fleet\.orbitBodyId === null \? 'unknown' : )'left-behind'/, to: (found0) => `${found0[1]}'follows'`, fails: ['orbit'] },
  { name: 'a distance between two systems worked out', file: U, at: /const km = sameSystem \? kmBetween\(fleet, station\) : null/, to: () => 'const km = kmBetween(fleet, station)', fails: ['orbit'] },
  { name: 'a fleet whose system is unknown taken for another system', file: U, at: /(finite\(fleet\.systemId, station\.systemId\) \? fleet\.systemId === station\.systemId : )null/, to: (found0) => `${found0[1]}false`, fails: ['orbit'] },
  { name: 'a fleet assigned to the colony not at its base', file: U, at: /const assigned = fleet\.assignedPopulationId !== null && fleet\.assignedPopulationId > 0 && fleet\.assignedPopulationId === colony\.id/, to: () => 'const assigned = false', fails: ['orbit'] },
  { name: 'a note attached to a fleet whose ID is held by another object', file: U, at: /current\.filter\(\(entry\) => entry\.fleetState === VERDICTS\.HELD\)\.forEach\(/, to: () => 'current.forEach(', fails: ['reuse'] },
  { name: 'an object that is not shown to be the one named taken as held', file: U, at: /return \{ state: VERDICTS\.REVIEW, basis: 'unwitnessed'/, to: () => "return { state: VERDICTS.HELD, basis: 'confirmed'", fails: ['reuse'] },
  { name: 'an ID that another object took taken as held', file: U, at: /return \{ state: VERDICTS\.REVIEW, basis: 'reused'/, to: () => "return { state: VERDICTS.HELD, basis: 'evidence'", fails: ['reuse'] },
  { name: 'a confirmation that ignores the name', file: U, at: /\s*&&\s*confirmed\.name === row\.name/, to: () => '', fails: ['reuse'] },
  { name: 'a confirmation that ignores the ship classes', file: U, at: /\(ref\.type !== 'fleet' \|\| overlaps\(confirmed\.classes, row\.classes\)\)/, to: () => 'true', fails: ['reuse'] },
  { name: 'a station under review compared as the one named', file: U, at: /if \(view\.verdict\.state === VERDICTS\.REVIEW\) \{/, to: () => 'if (false) {', fails: ['reuse'] },
  { name: 'a fleet under review compared as the fleet named', file: U, at: /if \(!fleetHeld\) \{/, to: () => 'if (false) {', fails: ['reuse'] },
  { name: 'a second note for one fleet kept', file: U, at: /if \(!entry && listedAt\(scope\.branchId\)\.length\) \{/, to: () => 'if (false) {', fails: ['reuse'] },
  { name: 'a held reference confirmed again', file: U, at: /view\.verdict\.state !== VERDICTS\.REVIEW \|\| !view\.row/, to: () => '!view.row', fails: ['reuse'] },
  { name: 'a kind that was not read taken for gone', file: U, at: /objects instanceof Map \? objects\.get\(link\.id\) \|\| null : UNREAD/, to: () => 'objects instanceof Map ? objects.get(link.id) || null : null', fails: ['unread'] },
  { name: 'a link that could not be checked taken for gone', file: U, at: /return \{ state: VERDICTS\.UNREAD, basis: null/, to: () => 'return { state: VERDICTS.GONE, basis: null', fails: ['unread'] },
  { name: 'a deleted station or base not marked stale', file: U, at: /stale: ahead \? \[\] : \[station, base\]\.filter\(\(view\) => view && view\.verdict\.state === VERDICTS\.GONE\)\.map\(\(view\) => view\.role\)/, to: () => 'stale: []', fails: ['stale'] },
  { name: 'the saved orders put into the note', file: U, at: /intent: entry \? entry\.intent : null,/, to: () => 'intent: entry ? { ...entry.intent, orders: ordersOf(fleet, orders, entry) } : null,', fails: ['separation'] },
  { name: 'the location folded into the place of the fleet', file: U, at: /place: placeOf\(fleet\),/, to: () => 'place: { ...placeOf(fleet), location: entry ? entry.location : null },', fails: ['separation'] },
  { name: 'the note\'s words put into the saved orders', file: U, at: /return \{ read: true, list, destination, standoff \}/, to: () => 'return { read: true, list, destination, standoff, note: entry ? entry.intent.note : null }', fails: ['separation'] },
  { name: 'the last order said to end at the station whatever its destination', file: U, at: /const same = last\.destinationId === null \? null : last\.destinationId === station\.id/, to: () => 'const same = true', fails: ['orders'] },
  { name: 'an order to a waypoint with the ID of the body taken for an order to the body', file: U, at: /station\.type === 'body' \? BODY_DESTINATIONS\.includes\(last\.destinationType\) : last\.destinationType === WAYPOINT_DESTINATION/, to: () => 'true', fails: ['orders'] },
  { name: 'a fleet off station given no move step', file: U, at: /\} else if \(comparison && comparison\.state !== 'on'\) \{\n\s*steps\.push\(\{ key: 'move'/, to: (found0) => found0[0].replace(/\} else if \(comparison && comparison\.state !== 'on'\) \{/, '} else if (false) {'), fails: ['checklist'] },
  { name: 'a station that is gone given no step to pick it again', file: U, at: /if \(station\.verdict\.state !== VERDICTS\.HELD\) \{/, to: () => 'if (false) {', fails: ['checklist'] },
  { name: 'an unknown comparison given a result of the rule', file: U, at: /state === 'unknown' \? unavailable\(\{ rule: 'fleetStation\.onStation', missing, present \}\) : ofRule/, to: () => 'false ? unavailable({ rule: \'fleetStation.onStation\', missing, present }) : ofRule', fails: ['marks'] },
  { name: 'the distance given as a figure with no result', file: U, at: /(const distanceResult = \(km\) => \(km === null \? null : ofRule\(\{ rule: )'fleetStation\.distance'/, to: (found0) => `${found0[1]}'fleetStation.onStation'`, fails: ['marks'] },
  { name: 'a null coordinate read as 0', file: U, at: /x: numberOrNull\(source\.Xcor\),\n\s*y: numberOrNull\(source\.Ycor\),\n\s*classes/, to: (found0) => found0[0].replace('numberOrNull(source.Xcor)', 'Number(source.Xcor)'), fails: ['loaders'] },
  { name: 'a waypoint marked for deletion read', file: U, at: /\s+and FCT_Waypoint\.WaypointType != \$\{MARKED_FOR_DELETION\}/, to: () => '', fails: ['loaders'] },
  { name: 'a kind that cannot be read left out of what failed', file: U, at: /failed\[key\] = messageOf\(error\)/, to: () => 'void error', fails: ['loaders'] },
  { name: 'a failed read of the bodies swallowed', file: U, at: /keep\(\(await database\.query\(bodiesByIdSql\(batch\), \{ replacements \}\)\)\[0\]\)/, to: () => 'keep(await database.query(bodiesByIdSql(batch), { replacements }).then((answer) => answer[0], () => []))', fails: ['loaders'] },
  { name: 'a note kept for an object picked from another race or branch', file: U, at: /if \(!checked\[role\]\.ok\) \{/, to: () => 'if (false) {', fails: ['write'] },
  { name: 'the fleet of a note changed by an edit', file: U, at: /if \(entry && fleet !== undefined\) \{/, to: () => 'if (false) {', fails: ['write'] },
  { name: 'a stale edit written over without being asked', file: U, at: /if \(!overwrite\) \{/, to: () => 'if (false) {', fails: ['write'] },
  { name: 'a delete that ignores the revision', file: U, at: /repository\.delete\(scope, entry\.uuid, entry\.revision\)/, to: () => 'repository.delete(scope, entry.uuid, repository.list(scope, { kind: STATION_KIND }).find((item) => item.record.uuid === entry.uuid).record.revision)', fails: ['write'] },
  { name: 'a note of any length', file: U, at: /payload\.note\.length > NOTE_LENGTH/, to: () => 'false', fails: ['payload'] },
  { name: 'a colony taken for a station', file: U, at: /station: Object\.freeze\(\['body', 'waypoint'\]\)/, to: () => "station: Object.freeze(['body', 'waypoint', 'colony'])", fails: ['payload'] },
  { name: 'a note with no confirmation held', file: U, at: /isObject\(ref\.origin\) && isText\(ref\.origin\.campaignId\) && isText\(ref\.origin\.branchId\) && confirmedOk\(ref\.confirmed\)/, to: () => 'true', fails: ['payload'] },
  { name: 'the bundle of reads used for another race', file: X, at: /(stationObjectsBundle\(\)\s*\{[\s\S]*?)\s*&&\s*bundle\.RaceID === this\.RaceID/, to: (found0) => found0[1], fails: ['optional'] },
  { name: 'a fleet list that failed taken as loaded', file: X, at: /if \(loaded\.failed\.fleet\) \{/, to: () => 'if (false) {', fails: ['optional'] },
  { name: 'the orders read with no database, game or race', file: X, at: /(stationOrders: \{[\s\S]*?)if \(!database \|\| !GameID \|\| !RaceID\) \{/, to: (found0) => `${found0[1]}if (false) {`, fails: ['page'] },
  { name: 'the retry reading every read of the panel', file: X, at: /\[\.\.\.new Set\(\[\.\.\.this\.stationFailedKeys, \.\.\.partial\]\)\]\.forEach\(/, to: () => 'STATION_INPUTS.forEach(', fails: ['optional'] },
  { name: 'the panel loading while a read has failed', file: X, at: /loading: failed\.length === 0 && !current/, to: () => 'loading: !current', fails: ['optional'] },
  { name: 'the bodies used though the read did not ask for those the notes name', file: X, at: /this\.stationBodyWanted\.every\(\(id\) => bundle\.requested\.has\(id\)\)/, to: () => 'true', fails: ['optional'] },
  { name: 'a read of the panel missing from its labels', file: X, at: /^[ \t]*stationOrders\s*:\s*(?:'[^']*'|"[^"]*"),[ \t]*\n/m, to: () => '', fails: ['page'] },
  { name: 'a read of the panel not tracked', file: X, at: /tracked\('stationBodies', /, to: () => "((name, read) => read)('stationBodies', ", fails: ['page'] },
  { name: 'the panel without its summary', file: V, at: /data-summary(?=\s*=\s*(?:"[^"]*"|'[^']*'))/, to: () => 'data-sum', fails: ['component'] },
  { name: 'a comparison without its mark', file: V, at: /(<template\s+#\[`item\.stationStatus`\]\s*=\s*"[^"]*"\s*>[\s\S]*?)<provenance-mark\b[^>]*\/>/, to: (found0) => found0[1], fails: ['component'] },
  { name: 'a distance without its mark', file: V, at: /(distanceText\([^)]*\)\s*\}\})<provenance-mark\b[^>]*\/>/, to: (found0) => found0[1], fails: ['component'] },
  { name: 'the count without its mark', file: V, at: /(data-station-count[^>]*>[^<]*)<provenance-mark\b[^>]*\/>/, to: (found0) => found0[1], fails: ['component'] },
  { name: 'the saved orders marked as the note', file: V, at: /(<section\b[^>]*)(\sdata-station-orders\b)/, to: (found0) => `${found0[1]} data-station-intent${found0[2]}`, fails: ['component'] },
  { name: 'the count shown while a read is out', file: V, at: /<v-chip\b[^>]*\bdata-station-count\b[^>]*>/, to: (found0) => found0[0].replace(/\sv-if\s*=\s*(?:"[^"]*"|'[^']*')/, ''), fails: ['component'] },
  { name: 'the form saved after the scope changed', file: V, at: /if \(draft\.scopeKey !== null && draft\.scopeKey !== this\.scopeKey\) \{/, to: () => 'if (false) {', fails: ['component'] },
  { name: 'the form never writing over a conflict', file: V, at: /,\s*overwrite\s*\}\)/, to: () => ' })', fails: ['component'] },
  { name: 'the fleets that have a note offered again', file: V, at: /\.filter\(\(choice\) => !noted\.has\(choice\.id\)\)/, to: () => '', fails: ['component'] },
  { name: 'the checklist carrying a link', file: V, at: /(<li\b[^>]*data-station-step[^>]*>[^<]*)(<\/li>)/, to: (found0) => `${found0[1]}<page-link :to="null" />${found0[2]}`, fails: ['component'] },
  { name: 'the page without the labels of the reads of the panel', file: P, at: /^[ \t]*\.\.\.STATION_LABELS,[ \t]*\n/m, to: () => '', fails: ['page'] },
  { name: 'the page waiting on the reads of the panel', file: P, at: /\s*&&\s*!STATION_INPUTS\.includes\(key\)/, to: () => '', fails: ['optional'] },
  { name: 'the page mounting the panel without its retry', file: P, at: /(<fleet-stations\b[^>]*?)\s@retry\s*=\s*(?:"[^"]*"|'[^']*')/, to: (found0) => found0[1], fails: ['page'] },
  { name: 'the page mounting the panel without its state', file: P, at: /(<fleet-stations\b[^>]*?)\s:state\s*=\s*(?:"[^"]*"|'[^']*')/, to: (found0) => found0[1], fails: ['page'] },
  { name: 'the page mounting the panel without its changes', file: P, at: /(<fleet-stations\b[^>]*?)\s@changed\s*=\s*(?:"[^"]*"|'[^']*')/, to: (found0) => found0[1], fails: ['page'] },
  { name: 'the page mounting the panel with no database', file: P, at: /(<fleet-stations\b[^>]*?)\s:database\s*=\s*(?:"[^"]*"|'[^']*')/, to: (found0) => found0[1], fails: ['page'] },
  { name: 'the stations view not one the page keeps', file: P, at: /,\s*stations\s*:\s*(?:'[^']*'|"[^"]*")(?=\s*\})/, to: () => '', fails: ['page'] },
  { name: 'the view with no button', file: P, at: /<v-btn\b[^>]*\bvalue\s*=\s*"stations"[^>]*>[\s\S]*?<\/v-btn>\s*/, to: () => '', fails: ['page'] },
  { name: 'the panel mounted in another view', file: P, at: /<template v-else-if="view === 'maintenance'">/, to: () => '<template v-else-if="view === \'stations\'">', fails: ['page'] },
  { name: 'a confirmation made after the branches parted relied on', file: U, at: /confirmationShared\(ref, context\) && /, to: () => '', fails: ['branch'] },
  { name: 'a confirmation of another branch dated to the open branch by an edit', file: U, at: /view\.verdict\.basis === 'evidence' && ref\.origin\.branchId === scope\.branchId/, to: () => "view.verdict.basis !== 'unknown'", fails: ['branch'] },
  { name: 'a note made after the open save attached and compared', file: U, at: /const ahead = item\.status === 'ahead'/, to: () => 'const ahead = false', fails: ['ahead'] },
  { name: 'a station with a null orbit compared as off station', file: U, at: /if \(km === null\) \{/, to: () => 'if (false) {', fails: ['orbit'] },
  { name: 'a base with a null orbit, assignment or body compared as away', file: U, at: /if \(fleet\.orbitBodyId === null \|\| fleet\.assignedPopulationId === null \|\| typeof colony\.bodyId !== 'number'\) \{/, to: () => 'if (false) {', fails: ['orbit'] },
  { name: 'notes of one fleet that overlap attached as the last of them', file: U, at: /same\.length === 1 \? same\[0\] : null/, to: () => 'same.length ? same[same.length - 1] : null', fails: ['overlap'] },
  { name: 'a note shared with the campaign met by another note of the fleet', file: U, at: /if \(policy === 'campaign' && \(!entry \|\| entry\.policy !== 'campaign'\)\) \{/, to: () => 'if (false) {', fails: ['overlap'] },
  { name: 'a minimum distance told as none', file: U, at: /last\.minDistance === null \? 'unknown' : last\.minDistance > 0 \? 'set' : 'none'/, to: () => "'none'", fails: ['orders'] },
  { name: 'a kind that failed inside the objects read never retried', file: X, at: /Object\.keys\(this\.stationObjectsBundle\.failed\)\.length > 0/, to: () => 'false', fails: ['optional'] },
  { name: 'the Retry of a kind that could not be read left out', file: V, at: /<v-btn\b[^>]*\bdata-station-problem-retry\b[^>]*>[^<]*<\/v-btn>/, to: () => '', fails: ['component'] },
  { name: 'an order whose arrival is not recorded marked as arrived', file: V, at: /order\.arrived === true \? ('[^']*') : ('[^']*')/, to: (found0) => `order.arrived !== false ? ${found0[1]} : ${found0[2]}`, fails: ['component'] },
  { name: 'an order that has not arrived marked as arrived', file: V, at: /:data-station-order-arrived="[^"]*"/, to: () => 'data-station-order-arrived="arrived"', fails: ['component'] },
  { name: 'a destination kind left null taken for another destination', file: U, at: /last\.destinationType === null \? null : /, to: () => '', fails: ['orders'] },
  { name: 'a destination ID left null taken for another destination', file: U, at: /last\.destinationId === null \? null : /, to: () => '', fails: ['orders'] },
  { name: 'a position match taken for a fleet left behind or a fixed point whatever is not known of the orbit', file: U, at: /const movement = anchorUnknown \? 'unknown' : anchor === null \? 'fixed' : fleet\.orbitBodyId === null \? 'unknown' : 'left-behind'/, to: () => "const movement = anchor === null ? 'fixed' : 'left-behind'", fails: ['orbit'] },
  { name: 'a waypoint tied to no known body taken for a fixed point', file: U, at: /anchorUnknown \? 'unknown' : (?=anchor === null \? 'fixed')/, to: () => '', fails: ['orbit'] },
  { name: 'a fleet whose movement is not known given the step to go into orbit', file: U, at: /comparison\.movement === 'left-behind'/, to: () => "comparison.movement !== 'follows'", fails: ['component'] },
  { name: 'a fleet whose movement is not known told to be a fixed point', file: V, at: /item\.location\[role\]\.movement === 'fixed'/, to: () => "item.location[role].movement !== 'left-behind'", fails: ['component'] },
  { name: 'the creation time of a waypoint made part of what names it', file: U, at: /(fingerprint: \(row\) => \['waypoint', present\(row\.systemId\), present\(row\.number\))\]/, to: (found0) => `${found0[1]}, present(row.created)]`, fails: ['reuse'] },
  { name: 'the number of a waypoint left out of what names it', file: U, at: /(fingerprint: \(row\) => \['waypoint', present\(row\.systemId\)), present\(row\.number\)\]/, to: (found0) => `${found0[1]}]`, fails: ['reuse'] },
  { name: 'ship classes the save does not give read as an empty list', file: U, at: /return known\.length > 0 \? known : ships === 0 \? \[\] : null/, to: () => 'return known', fails: ['loaders'] },
  { name: 'two lists of ship classes that are not known taken to overlap', file: U, at: /const overlaps = \(kept, now\) => Array\.isArray\(kept\) && Array\.isArray\(now\) && /, to: () => 'const overlaps = (kept, now) => (kept === null && now === null) || (Array.isArray(kept) && Array.isArray(now)) && ', fails: ['reuse'] },
  { name: 'a note taken for a fleet that no ship class and no date can ever show', file: U, at: /if \(!entry && unverifiable\('fleet', checked\.fleet\.row\)\) \{/, to: () => 'if (false) {', fails: ['reuse'] },
  { name: 'a confirmation taken for a fleet that no ship class and no date can ever show', file: U, at: /if \(unverifiable\(view\.type, checked\.row\)\) \{/, to: () => 'if (false) {', fails: ['reuse'] },
  { name: 'the Retry of the body picker left out', file: V, at: /<v-btn\b[^>]*\bdata-station-picker-retry\b[^>]*>[^<]*<\/v-btn>/, to: () => '', fails: ['component'] },
  { name: 'the Retry of the body picker reading no system', file: V, at: /<v-btn\b[^>]*\bdata-station-picker-retry\b[^>]*>/, to: (found0) => found0[0].replace('loadPicker(draft.stationSystem)', 'loadPicker(null)'), fails: ['component'] },
  { name: 'the count shown where the records or the scope are not there', file: V, at: /<v-chip\b[^>]*\bdata-station-count\b[^>]*>/, to: (found0) => found0[0].replace(/\sv-if\s*=\s*"[^"]*"/, ' v-if="view && !view.error"'), fails: ['component'] },
  { name: 'a figure that depends on the state in the summary', file: V, at: /\sdata-summary\s*=\s*(?:"[^"]*"|'[^']*')/, to: () => ' :data-summary="\'Notes kept: \' + notesCount"', fails: ['component'] },
  { name: 'the anchor of a waypoint left out of what holds it', file: U, at: /\s*&& \(ref\.type !== 'waypoint' \|\| sameAnchor\(confirmed\.anchor, waypointAnchorOf\(row\)\)\)/, to: () => '', fails: ['reuse'] },
  { name: 'the anchor of a waypoint not kept with its confirmation', file: U, at: /\.\.\.\(type === 'waypoint' \? \{ anchor: waypointAnchorOf\(row\) \} : \{\}\), /, to: () => '', fails: ['reuse'] },
  { name: 'the body a waypoint is tied to not compared', file: U, at: /now\.body === kept\.body/, to: () => 'now.body !== undefined', fails: ['reuse'] },
  { name: 'the position of a tied waypoint taken for its anchor', file: U, at: /return \{ body: row\.orbitBodyId \}/, to: () => 'return finite(row.x, row.y) ? { x: row.x, y: row.y } : null', fails: ['reuse'] },
  { name: 'a fixed point compared to the digit instead of within the unit', file: U, at: /Math\.abs\(now\.x - kept\.x\) < WAYPOINT_SAME_SPOT/, to: () => 'now.x === kept.x', fails: ['reuse'] },
  { name: 'a fixed point far from the confirmed one taken for the same spot', file: U, at: /const WAYPOINT_SAME_SPOT = 1\b/, to: () => 'const WAYPOINT_SAME_SPOT = 1000000', fails: ['reuse'] },
  { name: 'a waypoint whose tie the save does not give taken for a fixed point', file: U, at: /typeof row\.orbitBodyId !== 'number' \|\| !Number\.isFinite\(row\.orbitBodyId\)/, to: () => 'false', fails: ['reuse'] },
  { name: 'a note kept before the anchor was recorded taken as holding', file: U, at: /const sameAnchor = \(kept, now\) => \{/, to: () => 'const sameAnchor = (kept, now) => {\n  if (kept === undefined) {\n    return true\n  }\n', fails: ['reuse'] },
  { name: 'a note taken for a waypoint whose tie or position is not known', file: U, at: /if \(checked\.station && unverifiable\(picks\.station\.type, checked\.station\.row\)\) \{/, to: () => 'if (false) {', fails: ['reuse'] },
]
/* eslint-enable no-template-curly-in-string */

const MUTANTS = MUTATIONS.map((mutation, index) => ({ id: `mutant:${index}`, ...mutation }))

// The same planted faults on the source with every benign edit applied.
const COMPOSED = MUTATIONS.map((mutation, index) => ({ id: `composed:${index}`, ...mutation }))

// Edits that must change nothing the checks look at: wording, whitespace, the order of attributes and of lists. Each is located by its structure (the attribute, the key or the state it belongs to and its whole value, with any spacing around `=` and either quote), never by what it holds now, so it still applies after a rewording or another edit of the list.
const QUOTED = '"[^"]*"|\'[^\']*\''
const attribute = (name) => new RegExp(`(?<=\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(${QUOTED})`)
const valueOf = (quoted) => quoted.slice(1, -1)
const quote = (text) => (text.includes('"') ? `'${text}'` : `"${text}"`)

// The attributes inside a start tag, as name and whole value, put in the opposite order and written out again.
const ATTRIBUTES = new RegExp(`([^\\s=]+)(?:\\s*=\\s*(${QUOTED}))?`, 'g')
const reversed = (inside) => [...inside.matchAll(ATTRIBUTES)].reverse().map(([, name, value]) => (value === undefined ? name : `${name}=${value}`)).join(' ')
const STRING = '\'[^\']*\'|"[^"]*"|`[^`]*`'

const BENIGN = [
  { name: 'the summary reworded', file: V, at: attribute('data-summary'), to: () => 'data-summary="The notes kept for each fleet about where it is meant to sit and where it is meant to resupply, set beside the fleet and its saved orders."' },
  { name: 'the summary shortened to one sentence', file: V, at: attribute('data-summary'), to: () => 'data-summary="Intended stations and supply bases of the fleets, apart from their saved orders."' },
  { name: 'the summary naming a numbered product', file: V, at: attribute('data-summary'), to: () => 'data-summary="Intended fleet stations and supply bases in Aurora 4X, apart from saved orders."' },
  { name: 'the words of an unknown movement reworded', file: V, at: /(data-station-movement-unknown>)[^<]*(<\/div>)/, to: (found0) => `${found0[1]}The record does not say whether this station moves with the fleet, because an orbit is missing.${found0[2]}` },
  { name: 'the label of the retry of the body picker reworded', file: V, at: /(<v-btn\b[^>]*\bdata-station-picker-retry\b[^>]*>)[^<]*(<\/v-btn>)/, to: (found0) => `${found0[1]}Read the bodies again${found0[2]}` },
  { name: 'the words of the refusal of a waypoint without an anchor reworded', file: U, at: /(const NO_ANCHOR = ')[^']*(')/, to: (found0) => `${found0[1]}Nothing in the save tells where this waypoint is or what it is tied to, so a later read could not show that it is the waypoint named.${found0[2]}` },
  { name: 'the keys of the fixed anchor of a waypoint written in another order', file: U, at: /return finite\(row\.x, row\.y\) \? \{ (?:x: row\.x, y: row\.y|y: row\.y, x: row\.x) \} : null/, to: () => 'return finite(row.x, row.y) ? { y: row.y, x: row.x } : null' },
  { name: 'whitespace around the equals sign of a bound property on the mount', file: P, at: attribute(':scope'), to: (found0) => `:scope  =  ${found0[1]}` },
  { name: 'the attributes of the mount reordered', file: P, at: /(<fleet-stations)([^>]*?)(\s*\/>)/, to: (found0) => `${found0[1]} ${reversed(found0[2])}${found0[3]}` },
  { name: 'the bound values of the mount written another way', file: P, at: attribute(':repository-error'), to: (found0) => `:repository-error=${quote(`(${valueOf(found0[1])})`)}` },
  { name: 'the attributes of the count chip reordered', file: V, at: /(<v-chip)([^>]*?data-station-count[^>]*)(>)/, to: (found0) => `${found0[1]} ${reversed(found0[2])}${found0[3]}` },
  { name: 'whitespace in the mark of a comparison cell', file: V, at: /(<template\s+#\[`item\.stationStatus`\]\s*=\s*"[^"]*"\s*>[\s\S]*?)<provenance-mark\s+:result\s*=\s*(?:"[^"]*"|'[^']*')\s*\/>/, to: (found0) => `${found0[1]}<provenance-mark  :result = "item.location.station.result"  />` },
  { name: 'the attributes of the comparison cell reordered', file: V, at: /(<template\s+#\[`item\.stationStatus`\]\s*=\s*"[^"]*"\s*>\s*<span)([^>]*)>/, to: (found0) => `${found0[1]} ${reversed(found0[2])}>` },
  { name: 'the words of a step of the checklist reworded', file: V, at: new RegExp(`(if \\(step\\.key === 'orbit'\\) \\{\\s*return )(?:${STRING})`), to: (found0) => `${found0[1]}\`Put the fleet in orbit of \${step.target}.\`` },
  { name: 'the words of the verdicts reworded', file: V, at: /(const VERDICT_WORDS = \{)[^}]*(\})/, to: (found0) => `${found0[1]} evidence: 'Shown by the save', confirmed: 'Confirmed by the player', reused: 'Held by another object', unwitnessed: 'Not shown to be the same'${found0[2]}` },
  { name: 'the words of the places of a fleet that is off station reworded', file: V, at: /(const WHERE_WORDS = \{)[^}]*(\})/, to: (found0) => `${found0[1]} 'other-system': 'elsewhere in the galaxy', 'other-orbit': 'around another body', 'open-space': 'in the open'${found0[2]}` },
  { name: 'the table headers listed in the opposite order', file: V, at: /(headers\(\) \{\s*return \[)([\s\S]*?)(\s*\]\s*\})/, to: (found0) => `${found0[1]}${found0[2].split('\n').reverse().join('\n')}${found0[3]}` },
  { name: 'the foot of the panel reworded', file: V, at: /(data-station-limits>)[\s\S]*?(\s*<\/div>)/, to: (found0) => `${found0[1]}\n        Notes are local to the campaign; a fleet is matched to its note only where the save shows it or the player confirmed it.${found0[2]}` },
  { name: 'the label of the view reworded', file: P, at: /(stations\s*:\s*)(?:'[^']*'|"[^"]*")(?=\s*\})/, to: (found0) => `${found0[1]}'Stations of fleets'` },
  { name: 'the words naming the reads of the panel reworded', file: X, at: /(stationObjects\s*:\s*)(?:'[^']*'|"[^"]*")/, to: (found0) => `${found0[1]}'the fleets and the places they can sit at'` },
  { name: 'the assumptions of a note reworded', file: U, at: /(const ASSUMPTIONS = Object\.freeze\(\[)[^\]]*(\]\))/, to: (found0) => `${found0[1]}'The note is the player\\'s own and gives the game no order', 'The fleet a note names is the fleet only where the save shows it or the player confirmed that object'${found0[2]}` },
  { name: 'the reason of an unknown comparison reworded', file: U, at: /(if \(km === null\) \{\s*return UNKNOWN\('station', sameSystem === null \? )'(?:[^'\\]|\\.)*'/, to: (found0) => `${found0[1]}'The system of the fleet or of the station is not known.'` },
  { name: 'the arrival caveat of an order worded as a negated completion', file: V, at: /(<span v-if="order\.arrived">)[^<]*(<\/span>)/, to: (found0) => `${found0[1]} (arrived; work at the destination is not necessarily complete)${found0[2]}` },
].map((edit, index) => ({ id: `benign:${index}`, ...edit }))

// The text to find and its replacement for a planted fault or a benign edit: the literal `find` and `replace`, or what the pattern `at` matches (exactly once) and `to` makes of the match.
const resolved = (edit, text) => {
  if (!edit.at) {
    return edit
  }

  const all = [...text.matchAll(new RegExp(edit.at.source, `${edit.at.flags}g`))]

  if (all.length !== 1) {
    throw new Error(`The pattern of ${edit.name} matches ${all.length} times, not once`)
  }

  return { find: all[0][0], replace: edit.to(all[0]) }
}

// ---------- the parts: each mutant and the checks of the real sources run in a process of their own ----------

const TEXTS = Object.fromEntries(Object.entries(FILES).map(([name, file]) => [name, () => fs.readFileSync(file, 'utf8')]))

// The sources with one edit (a planted fault or a benign edit) applied.
const applied = (sources, edit) => {
  const change = resolved(edit, sources[edit.file])

  return { ...sources, [edit.file]: patched(path.basename(FILES[edit.file]), sources[edit.file], change.find, change.replace) }
}

// The sources one run reads: the real ones, or the real ones with one planted fault.
const sourcesOf = (mutant) => {
  const sources = Object.fromEntries(Object.keys(FILES).map((name) => [name, TEXTS[name]()]))

  return mutant ? applied(sources, mutant) : sources
}

// The real sources with every benign edit applied in turn.
const stackedSources = () => BENIGN.reduce((sources, edit) => applied(sources, edit), sourcesOf(null))

const contextOf = async (sources) => {
  const changed = (name) => sources[name] !== TEXTS[name]()
  const utilityName = changed(U) ? { 'fleet-stations': sources[U] } : {}
  const utilitySources = changed(U) ? { 'utilities/fleet-stations': sources[U] } : {}
  const mixinSources = changed(X) ? { 'mixins/fleet-stations': sources[X] } : {}
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, sources: utilityName })
  const options = await loadPage('components/fleets/FleetStations', { stubs: STUBS, sources: { 'components/fleets/FleetStations': sources[V], ...utilitySources } })
  const mixinOptions = await loadPage('mixins/fleet-stations', { stubs: STUBS, sources: { ...utilitySources, ...mixinSources } })
  const pageSources = { 'pages/logistics': sources[P], ...utilitySources, ...mixinSources }
  const pageOptions = await loadPage('pages/logistics', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB, 'mixins/persisted-view': RECORDER }, sources: pageSources })
  const persisted = globalThis.__persistedFields
  const livePageOptions = await loadPage('pages/logistics', { stubs: STUBS, modules: { 'components/charts/theme': THEME_STUB, 'mixins/load-state': null }, sources: pageSources })

  return { m: { fs: loaded['fleet-stations'], records: loaded['scenario-records'], provenance: loaded.provenance, placeData: loaded['place-data'] }, options, mixinOptions, pageOptions, livePageOptions, persisted, componentText: sources[V], pageText: sources[P], mixinText: sources[X] }
}

const keyOf = (name) => name.slice(0, name.indexOf(':'))

// The statements run, as [name, result]; `keys` limits them to the checks of those keys.
const runStatements = async (statements, keys = null) => {
  const results = []

  for (const [name, test] of statements) {
    if (keys && !keys.includes(keyOf(name))) {
      continue
    }

    let result

    try {
      result = await test()
    } catch (error) {
      result = `threw ${error.message}`
    }

    results.push([name, result])
  }

  return results
}

let useSaves = true

const statementsOf = async (ctx, withSaves) => {
  const statements = [...pure(ctx), ...panel(ctx), ...page(ctx), ...optional(ctx)]
  const opened = []
  const skipped = []

  if (withSaves && useSaves) {
    for (const save of SAVES) {
      const read = await saveStatements(ctx, save)

      if (read.skipped) {
        skipped.push(save.file)
      } else {
        statements.push(...read.statements)
        opened.push(read)
      }
    }
  }

  return { statements, opened, skipped }
}

const checkHead = async () => {
  const ctx = await contextOf(sourcesOf(null))
  const { statements, opened, skipped } = await statementsOf(ctx, true)

  console.log('\nFleet stations: the intended station and supply base of a fleet beside where it is and its saved orders, on fixtures worked by hand, the panel, the page and the saves')

  for (const file of skipped) {
    console.log(`SKIP  ${file} is not there`)
  }

  const keys = new Set(statements.map(([name]) => keyOf(name)))
  const bare = MUTATIONS.filter((mutation) => !mutation.fails.some((key) => !key.startsWith('save-') && keys.has(key))).map((mutation) => mutation.name)

  check('mutations: every planted fault names a group of checks that needs no save, so a checkout without the saves still catches it', bare.length ? short(bare) : true)

  for (const [name, result] of await runStatements(statements)) {
    check(name, result)
  }

  await Promise.all(opened.map((read) => read.close()))
}

const checkMutant = async (mutant, composed = false) => {
  const began = Date.now()
  const label = `${composed ? 'mutation caught on the stacked benign edits' : 'mutation caught'}: ${mutant.name}`
  let sources

  try {
    sources = composed ? applied(stackedSources(), mutant) : sourcesOf(mutant)
  } catch (error) {
    check(label, `invalid mutant: ${error.message}`)

    return
  }

  let ctx

  try {
    ctx = await contextOf(sources)
  } catch (error) {
    check(label, `does not load: ${error.message}`)

    return
  }

  const required = mutant.fails.filter((key) => !key.startsWith('save-'))
  const { statements } = await statementsOf(ctx, false)
  const present = (key) => statements.some(([name]) => keyOf(name) === key)
  const absent = required.filter((key) => !present(key))
  const results = await runStatements(statements, required)
  const missed = required.filter((key) => !results.some(([name, result]) => keyOf(name) === key && result !== true))

  check(label, !required.length ? 'names no group of checks that needs no save' : absent.length ? `no check has the key ${absent.join(', ')}` : missed.length ? `these checks did not fail: ${missed.join(', ')}` : true, `${results.filter(([, result]) => result !== true).length} of the checks it names fail, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

// An edit that changes no behaviour (wording, whitespace, the order of attributes or of a list) leaves every check that needs no save green: the checks look at what the sources do, not at how they are written.
const checkBenign = async (edit) => {
  const began = Date.now()
  let results

  try {
    const ctx = await contextOf(sourcesOf(edit))
    const { statements } = await statementsOf(ctx, false)

    results = await runStatements(statements)
  } catch (error) {
    check(`benign edit kept: ${edit.name}`, `does not load: ${error.message}`)

    return
  }

  const failed = results.filter(([, result]) => result !== true)

  check(`benign edit kept: ${edit.name}`, failed.length ? short(failed.map(([name, result]) => [name, result])) : true, `${results.length} checks stay green, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

// The benign edits are independent of one another: each is located by structure, so it still applies to a source another has already changed, and the source with every one of them applied (in order) is still green.
const checkStacked = async () => {
  const began = Date.now()
  const base = sourcesOf(null)
  const conflicts = []

  for (const first of BENIGN) {
    let after

    try {
      after = applied(base, first)
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

  check('benign edits: each still applies to a source another has changed', conflicts.length ? short(conflicts) : true, `${BENIGN.length * BENIGN.length} pairs`)

  let results

  try {
    const ctx = await contextOf(BENIGN.reduce((sources, edit) => applied(sources, edit), base))
    const { statements } = await statementsOf(ctx, false)

    results = await runStatements(statements)
  } catch (error) {
    check('benign edits: all of them together keep every check green', `does not load: ${error.message}`)

    return
  }

  const failed = results.filter(([, result]) => result !== true)

  check('benign edits: all of them together keep every check green', failed.length ? short(failed.map(([name, result]) => [name, result])) : true, `${results.length} checks stay green, ${((Date.now() - began) / 1000).toFixed(1)} s`)
}

const parseArguments = (argv) => {
  const options = { part: null, mutations: true, saves: true }

  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--part') {
      options.part = argv[++index]
    } else if (argv[index] === '--no-mutations') {
      options.mutations = false
    } else if (argv[index] === '--no-saves') {
      options.saves = false
    } else {
      console.error(`Unknown argument: ${argv[index]}`)
      process.exit(2)
    }
  }

  return options
}

const run = async () => {
  const options = parseArguments(process.argv.slice(2))

  useSaves = options.saves

  if (options.part !== null) {
    const mutant = MUTANTS.find(({ id }) => id === options.part)
    const edit = BENIGN.find(({ id }) => id === options.part)

    if (options.part === 'head') {
      await checkHead()
    } else if (mutant) {
      await checkMutant(mutant)
    } else if (COMPOSED.some(({ id }) => id === options.part)) {
      await checkMutant(COMPOSED.find(({ id }) => id === options.part), true)
    } else if (edit) {
      await checkBenign(edit)
    } else if (options.part === 'stacked') {
      await checkStacked()
    } else {
      throw new Error(`No part is named ${options.part}`)
    }

    endSection(checks, failures)
  }

  const wanted = options.mutations ? MUTANTS : []
  const benign = options.mutations ? BENIGN : []
  const extra = options.saves ? [] : ['--no-saves']
  const stacked = options.mutations ? ['stacked'] : []
  const composed = options.mutations ? COMPOSED : []
  const sections = await runSections(__filename, [{ args: ['--part', 'head', ...extra], weight: 30 }, ...[...wanted, ...benign, ...composed].map(({ id }) => ({ args: ['--part', id, ...extra], weight: 3 })), ...stacked.map((id) => ({ args: ['--part', id, ...extra], weight: 5 }))])
  let at = 0

  const printed = () => {
    const counts = printSection(sections[at++])

    checks += counts.checks
    failures += counts.failures
  }

  printed()

  if (wanted.length) {
    console.log('\nMutations: each must fail the checks it names')
    wanted.forEach(printed)
  }

  if (benign.length) {
    console.log('\nBenign edits: each must leave every save-free check green')
    benign.forEach(printed)
  }

  if (stacked.length) {
    console.log('\nBenign edits stacked: each still applies after any other, and all of them together leave every save-free check green')
    stacked.forEach(printed)
  }

  if (composed.length) {
    console.log('\nPlanted faults on the source with every benign edit applied: each must still apply once and fail the checks it names')
    composed.forEach(printed)
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
