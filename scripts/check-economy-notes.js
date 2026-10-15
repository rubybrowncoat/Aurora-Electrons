/*
  Checks the project notebook (utilities/economy-notes.js and src/renderer/pages/notebook.vue): notes on a body, colony, fleet or tech with a status and a next action, kept in the scenario repository for a campaign, race and branch.

  node scripts/check-economy-notes.js [--no-mutations]

  NOTES_FALRYX and NOTES_BOSCO point the saves checks at other folders of saves (or at none: a folder that is not there skips them). A check that needs the owner's saves and does not find them is reported as skipped, is not counted, and no mutant is expected to fail it.

  Groups:
  - links: each kind of target is linked where the save shows it is the object that was linked (a body by the discovery time of its system, a fleet by its creation time, a catalogue tech anywhere) and not checked where nothing does (a colony, a designed tech), a rename keeps the link and shows the new name, an object that is gone or an ID that another object took is never rebound, and on another branch a body is linked only if its system was found strictly before the branches parted;
  - stale: a deleted or changed target leaves the note readable, marked stale, with the name and system it last had, through a restart and an edit;
  - filter: the system filter finds the notes about a body, a colony and a fleet in a system, follows a fleet that moved and keeps a stale note in the system it was last known in;
  - isolation: another race, another branch and another campaign never list a note, a note shared with the campaign lists on every branch, the notes survive a restart and live in the campaign's scenario file;
  - edits: a note is made, edited, deleted, refused when stale or invalid, and an edit keeps the link;
  - scope: a link is made only against the objects of the race, campaign and branch the note is kept for, and only for an object that is there as it was picked;
  - picker and reads: the choices of the form, and every query the notebook sends is a select, so editing a note never writes the save;
  - saves: on the owner's saves (opened read only, skipped when they are not here) the objects load with the real queries, the bodies, colonies, fleets and designed techs whose IDs another branch gave again read as changed or not checked and never as linked, the catalogue is the same in two campaigns, and the renames of a line of saves keep the links;
  - backup: notes round-trip through the backup's annotation adapter;
  - page: the panels name what they are for in the page's voice, a note is kept from the form, listed, filtered, isolated by race and branch, a draft is dropped and refused when what is shown changes, and the backup registers the adapter.

  Everything runs on in-memory stores, the real scenario repository and a fake save that records the SQL it is sent. Each mutation of the utility or of the page must fail the checks it names. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createRequire } = require('module')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate, replacing } = require('./lib/page-loader')
const { inParallel, runChild, lastJson } = require('./lib/check-pool')
const { chunksOf, spread } = require('./lib/mutant-chunks')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const pageFile = path.join(root, 'src', 'renderer', 'pages', 'notebook.vue')
const historyPageFile = path.join(root, 'src', 'renderer', 'pages', 'history.vue')
const navigationFile = path.join(utilitiesDirectory, 'navigation.js')
const FALRYX = process.env.NOTES_FALRYX || path.join(root, 'artifacts', 'falryx-sequential-and-rollback')
const BOSCO = process.env.NOTES_BOSCO || path.join(root, 'artifacts', 'boscodiogigia-sequential-saves')
const NAMES = ['economy-notes', 'history-milestones', 'scenario-records', 'history-backup']

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  electron: 'export const ipcRenderer = { invoke: () => Promise.resolve(null) }',
  dayjs: `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs')}`,
  'dayjs/plugin/utc.js': `import { createRequire } from 'node:module'\nexport default ${requireOf('dayjs/plugin/utc.js')}`,
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

const localRequire = createRequire(path.join(root, 'package.json'))

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const unhashed = (text) => text.replace(/#\{/g, '$' + '{')

// ---- Fixtures --------------------------------------------------------------------------------------------------------

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

const world = (m, inst = memory()) => {
  const registry = m.records.createAdapterRegistry()
  let clock = 1000
  let ids = 0

  m.milestones.registerMilestones(registry.register)
  m.notes.registerEconomyNotes(registry.register)

  const make = (extra = {}) => m.records.createRepository({ storage: inst.storage, adapters: registry, newId: () => uuid(++ids), now: () => ++clock, ...extra })

  return { inst, registry, make, repo: make() }
}

const scope = (branchId = 'b1', RaceID = 7, campaignId = 'c1', gameTime = 100000) => ({ campaignId, RaceID, branchId, gameTime })

// The branches of the campaign c1 as the registry holds them (`branchLineage`): b2 left b1 at game time 1000, b3 left b1 at 3000.
const TREE = { b1: { parent: null, t: null }, b2: { parent: 'b1', t: 1000 }, b3: { parent: 'b1', t: 3000 }, b4: { parent: 'b1', t: null } }

// ---- A fake save: the tables the queries of the notebook read -----------------------------------------------------------

const system = (id, name, discovered) => ({ id, name, discovered })

const body = (id, name, systemId, planet = 1, orbit = 0, bodyClass = 1, bodyType = 2) => ({ id, name, systemId, planet, orbit, bodyClass, bodyType })

const colony = (id, name, systemId, bodyId, speciesId = 7) => ({ id, name, systemId, bodyId, speciesId })

const fleet = (id, name, created, systemId) => ({ id, name, created, systemId })

const tech = (id, name, typeId = 80, info = 100, cost = 500, researched = true) => ({ id, name, typeId, info, info2: 0, cost, researched })

const design = (id, name, typeId = 113, info = 0, cost = 100) => ({ id, name, typeId, info, info2: 0, cost })

const SAVE = () => ({
  systems: [system(1, 'Sol', 500), system(2, 'Alpha Centauri', 2000)],
  bodies: [body(100, 'Earth', 1, 3), body(101, 'Mars', 1, 4), body(200, 'Proxima b', 2, 2)],
  colonies: [colony(10, 'Earth Prime', 1, 100), colony(11, 'Proxima Base', 2, 200)],
  fleets: [fleet(30, '1st Fleet', 400, 1), fleet(31, '2nd Fleet', 2500, 2)],
  techs: [tech(3, 'Cargo Hold'), tech(4, 'Cargo Shuttle', 80, 50, 250), tech(5, 'Deep Scan', 81, 9, 900, false)],
  designs: [design(900, 'Ion Drive A'), design(901, 'Ion Drive B', 113, 0, 31)],
})

const edited = (save, change) => {
  const copy = clone(save)

  change(copy)

  return copy
}

const found = (list, id) => list.find((row) => row.id === id)

// `failing` names a fragment of SQL that makes the fake throw, as a save that lacks a table does. The fake answers by the table the SQL names and records everything it is sent.
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

      if (sql.startsWith('select FCT_SystemBody.')) {
        const wanted = /FCT_SystemBody\.SystemBodyID in \(([\d, ]+)\)/.exec(sql)
        const ids = wanted ? wanted[1].split(',').map((part) => Number(part.trim())) : null
        const only = sql.includes(':SystemID') ? options.replacements.SystemID : null

        return [save.bodies.filter((row) => (ids ? ids.includes(row.id) : row.systemId === only)).filter((row) => found(save.systems, row.systemId)).map((row) => ({ SystemBodyID: row.id, SystemID: row.systemId, BodyClass: row.bodyClass, BodyTypeID: row.bodyType, PlanetNumber: row.planet, OrbitNumber: row.orbit, Component: 1, SystemBodyName: row.name, SystemName: named(row.systemId), DiscoveredTime: found(save.systems, row.systemId).discovered }))]
      }

      if (sql.includes('from FCT_Population')) {
        return [save.colonies.map((row) => ({ PopulationID: row.id, PopName: row.name, SpeciesID: row.speciesId, SystemID: row.systemId, SystemBodyID: row.bodyId, SystemName: named(row.systemId) }))]
      }

      if (sql.startsWith('select FCT_Fleet.FleetID')) {
        return [save.fleets.map((row) => ({ FleetID: row.id, FleetName: row.name, SystemID: row.systemId, SystemName: named(row.systemId), CreatedTime: row.created }))]
      }

      if (sql.startsWith('select FCT_TechSystem.') && sql.includes('FCT_TechSystem.GameID = 0')) {
        return [save.techs.map((row) => ({ TechSystemID: row.id, Name: row.name, TechTypeID: row.typeId, DevelopCost: row.cost, AdditionalInfo: row.info, AdditionalInfo2: row.info2, RaceID: 0, TechTypeName: 'Type ' + row.typeId, Researched: row.researched ? row.id : null }))]
      }

      if (sql.startsWith('select FCT_TechSystem.')) {
        return [save.designs.map((row) => ({ TechSystemID: row.id, Name: row.name, TechTypeID: row.typeId, DevelopCost: row.cost, AdditionalInfo: row.info, AdditionalInfo2: row.info2, RaceID: 7, TechTypeName: 'Type ' + row.typeId }))]
      }

      if (sql.startsWith('select FCT_RaceSysSurvey.SystemID')) {
        return [save.systems.map((row) => ({ SystemID: row.id, Name: row.name, DiscoveredTime: row.discovered, SystemNumber: row.id, Stars: 1 }))]
      }

      throw new Error(`the fake save does not answer ${sql}`)
    },
  }
}

// ---- The suite -------------------------------------------------------------------------------------------------------

const KINDS = { body: 100, colony: 10, fleet: 30, tech: 3, design: 900 }

const suite = (m) => {
  const checks = []
  const check = (group, name, run) => checks.push({ group, name, run })
  const { notes, milestones } = m

  // The objects of an open save as the page hands them to the notes: the objects, the bodies the links name and the system picked, with the campaign and branch the save is open on.
  const open = async (save, where = scope(), { bodyIds = save.bodies.map((row) => row.id), systemId = null, branches = TREE, failing = [] } = {}) => {
    const database = fakeSave(save, { failing })
    const objects = await notes.loadNoteObjects(database, { GameID: 1, RaceID: where.RaceID })
    const bodies = await notes.loadBodies(database, { GameID: 1, RaceID: where.RaceID, bodyIds, systemId })
    const merged = notes.withBodies(objects, bodies)

    return { ...merged, campaignId: where.campaignId, branchId: where.branchId, branches, database }
  }

  const aim = (context, type, id) => ({ type, row: context.objects[type].get(id) })

  const keep = (w, where, context, type, id, extra = {}) => notes.saveNote(w.repo, where, { title: `Plan for ${type} ${id}`, status: 'planned', next: 'Do the next thing', target: aim(context, type, id), context, ...extra })

  const kept = async (w, where, context, type, id, extra = {}) => {
    const outcome = await keep(w, where, context, type, id, extra)

    assert.equal(outcome.ok, true, outcome.message)

    return outcome.record
  }

  const keepAll = async (w, where, context) => {
    for (const [type, id] of Object.entries(KINDS)) {
      await kept(w, where, context, type, id)
    }
  }

  const entriesOf = (w, where, context = null) => notes.readNotes(w.repo, where, context).entries

  const entryFor = (entries, type) => entries.find((entry) => entry.target.type === type)

  // The branch notes made on b1 and read by the open save of branch b2 (made at the same time as `save`), in the campaign c1.
  const readOn = async (w, save, where, options) => entriesOf(w, where, await open(save, where, options))

  // ---- links --------------------------------------------------------------------------------------------------------

  check('links', 'a body, a fleet and a catalogue tech are linked on the branch the note was made on, a colony and a designed tech are not checked and never linked', async () => {
    const w = world(m)
    const save = SAVE()
    const context = await open(save)

    await keepAll(w, scope(), context)

    const entries = entriesOf(w, scope(), context)

    assert.equal(entries.length, 5)
    ;['body', 'fleet', 'tech'].forEach((type) => {
      const entry = entryFor(entries, type)

      assert.equal(entry.link.status, 'linked', type)
      assert.equal(entry.stale, false, type)
    })
    ;['colony', 'design'].forEach((type) => {
      const entry = entryFor(entries, type)

      assert.equal(entry.link.status, 'unknown', type)
      assert.equal(entry.link.unverified, true, type)
      assert.match(entry.link.reason, /^Not checked/, type)
      assert.equal(entry.stale, false, type)
    })
    assert.match(entryFor(entries, 'design').link.reason, /designed/)
    assert.match(entryFor(entries, 'colony').link.reason, /colony/)
  })

  check('links', 'the record\'s own link holds the fingerprint the kind gives, and a colony and a fleet are named as the milestones name them', async () => {
    const w = world(m)
    const context = await open(SAVE())

    await keepAll(w, scope(), context)

    for (const entry of entriesOf(w, scope(), context)) {
      const [stored] = entry.links
      const row = context.objects[entry.target.type].get(entry.target.id)

      assert.equal(stored.type, entry.target.type)
      assert.equal(stored.id, entry.target.id)
      assert.equal(stored.fingerprint, notes.NOTE_TARGETS[entry.target.type].fingerprint(row))
    }

    const colonyRow = context.objects.colony.get(10)
    const fleetRow = context.objects.fleet.get(30)

    assert.equal(notes.NOTE_TARGETS.colony.fingerprint(colonyRow), milestones.LINK_TYPES.colony.fingerprint(colonyRow))
    assert.equal(notes.NOTE_TARGETS.fleet.fingerprint(fleetRow), milestones.LINK_TYPES.fleet.fingerprint(fleetRow))
  })

  check('links', 'no fingerprint holds a name, so a rename never changes it', async () => {
    const context = await open(SAVE())

    for (const [type, id] of Object.entries(KINDS)) {
      const row = context.objects[type].get(id)

      assert.equal(notes.NOTE_TARGETS[type].fingerprint(row), notes.NOTE_TARGETS[type].fingerprint({ ...row, name: 'Another name' }), type)
      assert.equal(notes.NOTE_TARGETS[type].fingerprint(row).includes(row.name), false, type)
    }
  })

  check('links', 'a renamed body, fleet and tech stays linked and shows its new name beside the one kept', async () => {
    const w = world(m)
    const save = SAVE()

    await keepAll(w, scope(), await open(save))

    const renamed = edited(save, (copy) => {
      found(copy.bodies, 100).name = 'Terra'
      found(copy.fleets, 30).name = 'Home Fleet'
      found(copy.techs, 3).name = 'Cargo Hold (large)'
    })
    const entries = await readOn(w, renamed, scope())

    for (const [type, now, was] of [['body', 'Terra', 'Earth'], ['fleet', 'Home Fleet', '1st Fleet'], ['tech', 'Cargo Hold (large)', 'Cargo Hold']]) {
      const entry = entryFor(entries, type)

      assert.equal(entry.link.status, 'linked', type)
      assert.equal(entry.link.nowNamed, now, type)
      assert.equal(entry.target.name, was, type)
      assert.equal(entry.stale, false, type)
    }
  })

  check('links', 'a renamed system leaves the generated name of an unnamed body to follow it, and the link holds', async () => {
    const w = world(m)
    const save = edited(SAVE(), (copy) => {
      found(copy.bodies, 100).name = null
    })

    await kept(w, scope(), await open(save), 'body', 100)

    const renamed = edited(save, (copy) => {
      found(copy.systems, 1).name = 'Sol Prime'
    })
    const [entry] = await readOn(w, renamed, scope())

    assert.equal(entry.target.name, 'Sol-A 3')
    assert.equal(entry.link.status, 'linked')
    assert.equal(entry.link.nowNamed, 'Sol Prime-A 3')
  })

  check('links', 'a renamed colony stays not checked, and the colony that holds the ID now is named apart from the link, never as the link', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(w, scope(), await open(save), 'colony', 10)

    const renamed = edited(save, (copy) => {
      found(copy.colonies, 10).name = 'New Earth'
    })
    const [entry] = await readOn(w, renamed, scope())

    assert.equal(entry.link.status, 'unknown')
    assert.equal(entry.link.nowNamed, null)
    assert.equal(entry.holderName, 'New Earth')
    assert.equal(entry.target.name, 'Earth Prime')
    assert.equal(entry.stale, false)
  })

  check('links', 'a link is never rebound: a new object with the same name and another ID does not take the place of a deleted one', async () => {
    const w = world(m)
    const save = SAVE()

    await keepAll(w, scope(), await open(save))

    const replaced = edited(save, (copy) => {
      copy.bodies = [body(150, 'Earth', 1, 3), ...copy.bodies.filter((row) => row.id !== 100)]
      copy.colonies = [colony(60, 'Earth Prime', 1, 100), ...copy.colonies.filter((row) => row.id !== 10)]
      copy.fleets = [fleet(70, '1st Fleet', 400, 1), ...copy.fleets.filter((row) => row.id !== 30)]
      copy.techs = [tech(80, 'Cargo Hold'), ...copy.techs.filter((row) => row.id !== 3)]
      copy.designs = [design(950, 'Ion Drive A'), ...copy.designs.filter((row) => row.id !== 900)]
    })
    const entries = await readOn(w, replaced, scope(), { bodyIds: [100, 150] })

    for (const type of Object.keys(KINDS)) {
      const entry = entryFor(entries, type)

      assert.equal(entry.link.status, 'missing', type)
      assert.equal(entry.link.id, KINDS[type], type)
      assert.equal(entry.stale, true, type)
    }
  })

  check('links', 'an ID that a save gives to another object reads changed: a body at another place, a fleet made at another time, a colony at another body, a designed tech with other figures', async () => {
    const w = world(m)
    const save = SAVE()

    await keepAll(w, scope(), await open(save))

    const reused = edited(save, (copy) => {
      Object.assign(found(copy.bodies, 100), { planet: 9 })
      Object.assign(found(copy.colonies, 10), { bodyId: 101 })
      Object.assign(found(copy.fleets, 30), { created: 777 })
      Object.assign(found(copy.designs, 900), { cost: 12345 })
      Object.assign(found(copy.techs, 3), { cost: 1 })
    })
    const entries = await readOn(w, reused, scope(), { bodyIds: [100] })

    for (const type of Object.keys(KINDS)) {
      assert.equal(entryFor(entries, type).link.status, 'changed', type)
      assert.equal(entryFor(entries, type).stale, true, type)
    }
  })

  check('links', 'a colony ID given again to a colony at the same body and species is still not checked, never linked', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(w, scope(), await open(save), 'colony', 10)

    const again = edited(save, (copy) => {
      found(copy.colonies, 10).name = 'Another colony altogether'
    })
    const [entry] = await readOn(w, again, scope())

    assert.notEqual(entry.link.status, 'linked')
    assert.equal(entry.link.status, 'unknown')
  })

  check('links', 'on another branch a body is linked only when its system was found strictly before the branches parted', async () => {
    const w = world(m)
    const save = edited(SAVE(), (copy) => {
      copy.systems.push(system(3, 'Exactly then', 1000))
      copy.bodies.push(body(300, 'Then I', 3, 1))
    })
    const context = await open(save)

    for (const id of [100, 200, 300]) {
      await kept(w, scope('b1'), context, 'body', id, { policy: 'campaign' })
    }

    const entries = await readOn(w, save, scope('b2'), { bodyIds: [100, 200, 300] })
    const status = (id) => entries.find((entry) => entry.target.id === id).link.status

    assert.equal(status(100), 'linked')
    assert.equal(status(200), 'unknown')
    assert.equal(status(300), 'unknown')
    assert.match(entries.find((entry) => entry.target.id === 200).link.reason, /^Not checked/)
  })

  check('links', 'on another branch a fleet follows the same rule, and a link whose branches the registry does not date is not checked', async () => {
    const w = world(m)
    const save = SAVE()
    const context = await open(save)

    await kept(w, scope('b1'), context, 'fleet', 30, { policy: 'campaign' })
    await kept(w, scope('b1'), context, 'fleet', 31, { policy: 'campaign' })

    const entries = await readOn(w, save, scope('b2'))

    assert.equal(entries.find((entry) => entry.target.id === 30).link.status, 'linked')
    assert.equal(entries.find((entry) => entry.target.id === 31).link.status, 'unknown')

    const undated = await readOn(w, save, scope('b4'))

    assert.equal(undated.find((entry) => entry.target.id === 30).link.status, 'unknown')
  })

  check('links', 'a catalogue tech is linked on any branch and in any campaign, and the same ID with other figures is changed', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(w, scope('b1'), await open(save), 'tech', 3, { policy: 'campaign' })

    for (const where of [scope('b2'), scope('b4')]) {
      assert.equal((await readOn(w, save, where))[0].link.status, 'linked', where.branchId)
    }

    const sameCampaignOther = await open(save, scope('b1', 7, 'c2'))
    const stored = entriesOf(w, scope('b1'), sameCampaignOther)[0]

    assert.equal(stored.link.status, 'linked')
    assert.equal(notes.NOTE_TARGETS.tech.identity, 'static')

    const reissued = edited(save, (copy) => {
      found(copy.techs, 3).info = 1
    })

    assert.equal((await readOn(w, reissued, scope('b1')))[0].link.status, 'changed')
  })

  check('links', 'a link read with no objects is not checked, a kind the save could not give is not checked and never gone, and bodies not read yet are not gone', async () => {
    const w = world(m)
    const save = SAVE()
    const context = await open(save)

    await keepAll(w, scope(), context)

    for (const entry of entriesOf(w, scope(), null)) {
      assert.equal(entry.link.status, 'unknown', entry.target.type)
      assert.equal(entry.stale, false, entry.target.type)
    }

    const noTechs = await open(save, scope(), { failing: ['FCT_RaceTech'] })

    assert.equal(noTechs.objects.tech, undefined)

    const unread = notes.readNotes(w.repo, scope(), noTechs).entries

    assert.equal(entryFor(unread, 'tech').link.status, 'unknown')
    assert.equal(entryFor(unread, 'tech').stale, false)
    assert.equal(entryFor(unread, 'fleet').link.status, 'linked')

    const unreadBodies = notes.withBodies(await notes.loadNoteObjects(fakeSave(save), { GameID: 1, RaceID: 7 }), null)
    const withoutBodies = notes.readNotes(w.repo, scope(), { ...unreadBodies, campaignId: 'c1', branchId: 'b1', branches: TREE }).entries

    assert.equal(entryFor(withoutBodies, 'body').link.status, 'unknown')
    assert.equal(entryFor(withoutBodies, 'body').stale, false)
  })

  // ---- stale --------------------------------------------------------------------------------------------------------

  const gone = (save) => edited(save, (copy) => {
    copy.bodies = copy.bodies.filter((row) => row.id !== 100)
    copy.colonies = copy.colonies.filter((row) => row.id !== 10)
    copy.fleets = copy.fleets.filter((row) => row.id !== 30)
    copy.techs = copy.techs.filter((row) => row.id !== 3)
    copy.designs = copy.designs.filter((row) => row.id !== 900)
  })

  check('stale', 'a deleted target leaves the note readable, marked stale, with the name and the system it last had', async () => {
    const w = world(m)
    const save = SAVE()

    await keepAll(w, scope(), await open(save))

    const entries = await readOn(w, gone(save), scope(), { bodyIds: [100] })
    const names = { body: 'Earth', colony: 'Earth Prime', fleet: '1st Fleet', tech: 'Cargo Hold', design: 'Ion Drive A' }

    assert.equal(entries.length, 5)

    for (const type of Object.keys(KINDS)) {
      const entry = entryFor(entries, type)

      assert.equal(entry.stale, true, type)
      assert.equal(entry.link.status, 'missing', type)
      assert.equal(entry.target.name, names[type], type)
      assert.equal(entry.title, `Plan for ${type} ${KINDS[type]}`, type)
      assert.equal(entry.next, 'Do the next thing', type)
      assert.equal(entry.status, 'planned', type)
    }

    assert.deepEqual(['body', 'colony', 'fleet'].map((type) => entryFor(entries, type).target.systemName), ['Sol', 'Sol', 'Sol'])
  })

  check('stale', 'a changed link is stale too and keeps the name the note was kept with, not the name of the object that has the ID now', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(w, scope(), await open(save), 'fleet', 30)

    const reused = edited(save, (copy) => {
      Object.assign(found(copy.fleets, 30), { name: 'Somebody else\'s fleet', created: 9000 })
    })
    const [entry] = await readOn(w, reused, scope())

    assert.equal(entry.link.status, 'changed')
    assert.equal(entry.stale, true)
    assert.equal(entry.target.name, '1st Fleet')
    assert.notEqual(entry.link.nowNamed, 'Somebody else\'s fleet')
    assert.equal(entry.link.nowNamed, null)

    const context = await open(reused)
    const edit = await notes.saveNote(w.repo, scope(), { entry, title: 'Edited over a reused ID', status: 'blocked', next: '', context })

    assert.equal(edit.ok, true, edit.message)

    const [after] = entriesOf(w, scope(), context)

    assert.equal(after.target.name, '1st Fleet')
    assert.equal(after.link.status, 'changed')
    assert.equal(after.stale, true)
  })

  check('stale', 'a note that is not checked is not stale', async () => {
    const w = world(m)

    await kept(w, scope(), await open(SAVE()), 'colony', 10)

    assert.equal((await readOn(w, SAVE(), scope()))[0].stale, false)
  })

  check('stale', 'a stale note is read the same after a restart, with its name and system', async () => {
    const inst = memory()
    const first = world(m, inst)
    const save = SAVE()

    await keepAll(first, scope(), await open(save))

    const again = world(m, inst)
    const entries = await readOn(again, gone(save), scope(), { bodyIds: [100] })

    assert.equal(entries.filter((entry) => entry.stale).length, 5)
    assert.equal(entryFor(entries, 'body').target.name, 'Earth')
    assert.equal(entryFor(entries, 'fleet').target.systemId, 1)
  })

  check('stale', 'a stale note is edited without a new link and stays stale with its last known name', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(w, scope(), await open(save), 'tech', 3)

    const missing = gone(save)
    const context = await open(missing)
    const [entry] = entriesOf(w, scope(), context)
    const outcome = await notes.saveNote(w.repo, scope(), { entry, title: 'Rethink the hold', status: 'blocked', next: 'Wait for the refit', context })

    assert.equal(outcome.ok, true, outcome.message)

    const [after] = entriesOf(w, scope(), context)

    assert.equal(after.title, 'Rethink the hold')
    assert.equal(after.stale, true)
    assert.equal(after.target.name, 'Cargo Hold')
    assert.equal(after.link.status, 'missing')
  })

  check('stale', 'a stale note is linked to another object only because the player picks it, and is then not stale', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(w, scope(), await open(save), 'tech', 3)

    const missing = gone(save)
    const context = await open(missing)
    const [entry] = entriesOf(w, scope(), context)
    const outcome = await notes.saveNote(w.repo, scope(), { entry, title: entry.title, status: entry.status, next: entry.next, target: aim(context, 'tech', 4), context })

    assert.equal(outcome.ok, true, outcome.message)

    const [after] = entriesOf(w, scope(), context)

    assert.equal(after.target.id, 4)
    assert.equal(after.target.name, 'Cargo Shuttle')
    assert.equal(after.stale, false)
    assert.equal(after.link.status, 'linked')
  })

  check('stale', 'an edit while the link holds writes the name the object has now as the last known one', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(w, scope(), await open(save), 'fleet', 30)

    const renamed = edited(save, (copy) => {
      Object.assign(found(copy.fleets, 30), { name: 'Home Fleet', systemId: 2 })
    })
    const context = await open(renamed)
    const [entry] = entriesOf(w, scope(), context)

    assert.equal(entry.target.name, '1st Fleet')
    assert.equal((await notes.saveNote(w.repo, scope(), { entry, title: 'Rename test', status: 'idea', next: '', context })).ok, true)

    const [after] = entriesOf(w, scope(), context)

    assert.equal(after.target.name, 'Home Fleet')
    assert.equal(after.target.systemName, 'Alpha Centauri')
    assert.equal(after.link.nowNamed, null)
  })

  // ---- filter -------------------------------------------------------------------------------------------------------

  check('filter', 'the filter lists every note, the notes of no system and each system that holds a note with its count', async () => {
    const w = world(m)
    const context = await open(SAVE())

    await keepAll(w, scope(), context)

    const options = notes.systemOptions(entriesOf(w, scope(), context))

    assert.deepEqual(options.map((option) => [option.value, option.count]), [[notes.ALL_SYSTEMS, 5], [notes.NO_SYSTEM, 2], [1, 3]])
    assert.equal(options[0].text, 'All systems')
    assert.equal(options[1].text, 'No system')
    assert.equal(options[2].text, 'Sol')
  })

  check('filter', 'the notes of a system are the notes about its bodies, colonies and fleets, and a tech is under no system', async () => {
    const w = world(m)
    const save = SAVE()
    const context = await open(save)

    for (const [type, id] of [['body', 100], ['body', 101], ['body', 200], ['colony', 10], ['colony', 11], ['fleet', 30], ['fleet', 31], ['tech', 3], ['design', 900]]) {
      await kept(w, scope(), context, type, id)
    }

    const entries = entriesOf(w, scope(), context)
    const inSol = notes.filterBySystem(entries, 1)
    const inAlpha = notes.filterBySystem(entries, 2)

    assert.deepEqual(inSol.map((entry) => `${entry.target.type}:${entry.target.id}`).sort(), ['body:100', 'body:101', 'colony:10', 'fleet:30'])
    assert.deepEqual(inAlpha.map((entry) => `${entry.target.type}:${entry.target.id}`).sort(), ['body:200', 'colony:11', 'fleet:31'])
    assert.deepEqual(notes.filterBySystem(entries, notes.NO_SYSTEM).map((entry) => entry.target.type).sort(), ['design', 'tech'])
    assert.equal(notes.filterBySystem(entries, notes.ALL_SYSTEMS).length, 9)
    assert.equal(notes.filterBySystem(entries, 99).length, 0)
  })

  check('filter', 'the filter finds a linked body and a linked fleet inside a system', async () => {
    const w = world(m)
    const context = await open(SAVE())

    await kept(w, scope(), context, 'body', 100)
    await kept(w, scope(), context, 'fleet', 30)

    const found = notes.filterBySystem(entriesOf(w, scope(), context), 1)

    assert.deepEqual(found.map((entry) => entry.target.type).sort(), ['body', 'fleet'])
    assert.equal(found.every((entry) => entry.link.status === 'linked' && entry.place.lastKnown === false), true)
  })

  check('filter', 'a fleet that moved is found in the system it is in now, not the one it was kept in', async () => {
    const w = world(m)
    const save = SAVE()

    await kept(w, scope(), await open(save), 'fleet', 30)

    const moved = edited(save, (copy) => {
      found(copy.fleets, 30).systemId = 2
    })
    const entries = await readOn(w, moved, scope())

    assert.equal(notes.filterBySystem(entries, 2).length, 1)
    assert.equal(notes.filterBySystem(entries, 1).length, 0)
    assert.equal(entries[0].place.systemName, 'Alpha Centauri')
    assert.equal(entries[0].place.lastKnown, false)
  })

  check('filter', 'a note that is stale, or whose fleet is not known to be the one linked, is found in the system it was last known in and says so', async () => {
    const w = world(m)
    const save = SAVE()
    const context = await open(save)

    await kept(w, scope('b1'), context, 'body', 100, { policy: 'campaign' })
    await kept(w, scope('b1'), context, 'fleet', 31, { policy: 'campaign' })

    const gonebody = edited(save, (copy) => {
      copy.bodies = copy.bodies.filter((row) => row.id !== 100)
      found(copy.fleets, 31).systemId = 1
    })
    const entries = await readOn(w, gonebody, scope('b2'), { bodyIds: [100] })
    const stale = entries.find((entry) => entry.target.type === 'body')
    const parted = entries.find((entry) => entry.target.type === 'fleet')

    assert.equal(stale.stale, true)
    assert.deepEqual([stale.place.systemId, stale.place.systemName, stale.place.lastKnown], [1, 'Sol', true])
    assert.equal(parted.link.status, 'unknown')
    assert.deepEqual([parted.place.systemId, parted.place.lastKnown], [2, true])
    assert.equal(notes.filterBySystem(entries, 1).length, 1)
    assert.equal(notes.filterBySystem(entries, 2).length, 1)
  })

  // ---- isolation ----------------------------------------------------------------------------------------------------

  check('isolation', 'a race lists only its own notes', async () => {
    const w = world(m)
    const context = await open(SAVE())

    await kept(w, scope('b1', 7), context, 'body', 100, { policy: 'campaign' })
    await kept(w, scope('b1', 8), await open(SAVE(), scope('b1', 8)), 'fleet', 31, { policy: 'campaign' })

    assert.deepEqual(entriesOf(w, scope('b1', 7)).map((entry) => entry.target.type), ['body'])
    assert.deepEqual(entriesOf(w, scope('b1', 8)).map((entry) => entry.target.type), ['fleet'])
    assert.equal(entriesOf(w, scope('b1', 9)).length, 0)
  })

  check('isolation', 'a note is kept for its branch by default: another branch of the campaign does not list it, and a note shared with the campaign lists on every branch', async () => {
    const w = world(m)
    const context = await open(SAVE())

    const own = await kept(w, scope('b1'), context, 'body', 100)
    const shared = await kept(w, scope('b1'), context, 'body', 101, { policy: 'campaign' })

    assert.equal(own.association.policy, 'branch')
    assert.equal(shared.association.policy, 'campaign')
    assert.deepEqual(entriesOf(w, scope('b1')).map((entry) => entry.uuid).sort(), [own.uuid, shared.uuid].sort())
    assert.deepEqual(entriesOf(w, scope('b2')).map((entry) => entry.uuid), [shared.uuid])
    assert.deepEqual(entriesOf(w, scope('b3')).map((entry) => entry.uuid), [shared.uuid])

    const onB2 = await kept(w, scope('b2'), await open(SAVE(), scope('b2')), 'fleet', 30)

    assert.equal(entriesOf(w, scope('b1')).some((entry) => entry.uuid === onB2.uuid), false)
    assert.equal(entriesOf(w, scope('b2')).some((entry) => entry.uuid === onB2.uuid), true)
  })

  check('isolation', 'another campaign lists none of the notes of this one', async () => {
    const w = world(m)

    await kept(w, scope('b1'), await open(SAVE()), 'body', 100, { policy: 'campaign' })

    assert.equal(entriesOf(w, scope('b1', 7, 'c2')).length, 0)
  })

  check('isolation', 'the notes are the same after a restart: the files read by another repository give the same notes, revision and link', async () => {
    const inst = memory()
    const first = world(m, inst)
    const save = SAVE()
    const context = await open(save)

    await keepAll(first, scope(), context)

    const before = entriesOf(first, scope(), context)
    const again = world(m, inst)
    const after = entriesOf(again, scope(), context)

    assert.equal(after.length, 5)
    assert.deepEqual(after.map((entry) => [entry.uuid, entry.revision, entry.title, entry.link.status, entry.link.id]), before.map((entry) => [entry.uuid, entry.revision, entry.title, entry.link.status, entry.link.id]))
    assert.equal(entriesOf(again, scope('b2')).length, 0)
  })

  check('isolation', 'the notes live in the scenario file of their campaign, as records of their own kind, beside the milestones that they never mix with', async () => {
    const inst = memory()
    const w = world(m, inst)
    const context = await open(SAVE())

    await kept(w, scope('b1'), context, 'body', 100)
    await milestones.saveMilestone(w.repo, scope('b1'), { t: 5, type: 'other', text: 'a milestone' })

    assert.deepEqual([...inst.files.keys()], ['campaign-c1'])

    const stored = JSON.stringify(inst.files.get('campaign-c1'))

    assert.match(stored, /economy\.note/)
    assert.equal(entriesOf(w, scope('b1')).length, 1)
    assert.equal(milestones.readMilestones(w.repo, scope('b1')).entries.length, 1)
    assert.equal(entriesOf(w, scope('b1'))[0].title.includes('milestone'), false)
  })

  // ---- edits --------------------------------------------------------------------------------------------------------

  check('edits', 'a note is made with a title, a status, a next action and its object, trimmed, kept for the branch', async () => {
    const w = world(m)
    const context = await open(SAVE())
    const record = await kept(w, scope(), context, 'body', 101, { title: '  Terraform Mars  ', next: '  Send the terraformers  ', status: 'in-progress' })
    const [entry] = entriesOf(w, scope(), context)

    assert.equal(record.kind, notes.NOTE_KIND)
    assert.equal(record.revision, 1)
    assert.equal(entry.title, 'Terraform Mars')
    assert.equal(entry.next, 'Send the terraformers')
    assert.equal(entry.status, 'in-progress')
    assert.equal(entry.statusText, 'In progress')
    assert.equal(entry.policy, 'branch')
    assert.deepEqual(entry.target.origin, { campaignId: 'c1', branchId: 'b1' })
  })

  check('edits', 'an edit changes the fields it names, keeps the link and the uuid, and moves the revision on', async () => {
    const w = world(m)
    const context = await open(SAVE())
    const record = await kept(w, scope(), context, 'body', 101)
    const [entry] = entriesOf(w, scope(), context)
    const edit = await notes.saveNote(w.repo, scope(), { entry, title: 'Terraform it', status: 'done', next: '', context })

    assert.equal(edit.ok, true, edit.message)

    const [after] = entriesOf(w, scope(), context)

    assert.equal(after.uuid, record.uuid)
    assert.equal(after.revision, 2)
    assert.equal(after.title, 'Terraform it')
    assert.equal(after.status, 'done')
    assert.equal(after.next, '')
    assert.equal(after.target.id, 101)
    assert.equal(after.link.status, 'linked')
    assert.equal(after.links.length, 1)
    assert.equal(after.policy, 'branch')
  })

  check('edits', 'an edit can share the note with the campaign or take it back to its branch', async () => {
    const w = world(m)
    const context = await open(SAVE())

    await kept(w, scope(), context, 'body', 101)

    const [entry] = entriesOf(w, scope(), context)

    assert.equal((await notes.saveNote(w.repo, scope(), { entry, title: entry.title, status: entry.status, next: entry.next, context, policy: 'campaign' })).ok, true)
    assert.equal(entriesOf(w, scope('b2')).length, 1)

    const [shared] = entriesOf(w, scope(), context)

    assert.equal((await notes.saveNote(w.repo, scope(), { entry: shared, title: shared.title, status: shared.status, next: shared.next, context, policy: 'branch' })).ok, true)
    assert.equal(entriesOf(w, scope('b2')).length, 0)
  })

  check('edits', 'a stale edit is refused with the stored note and written over only when asked', async () => {
    const w = world(m)
    const context = await open(SAVE())

    await kept(w, scope(), context, 'body', 101)

    const [first] = entriesOf(w, scope(), context)

    assert.equal((await notes.saveNote(w.repo, scope(), { entry: first, title: 'Elsewhere', status: 'blocked', next: '', context })).ok, true)

    const refused = await notes.saveNote(w.repo, scope(), { entry: first, title: 'Mine', status: 'planned', next: '', context })

    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'revision-conflict')
    assert.equal(refused.stored.title, 'Elsewhere')
    assert.equal(entriesOf(w, scope(), context)[0].title, 'Elsewhere')

    const forced = await notes.saveNote(w.repo, scope(), { entry: first, title: 'Mine', status: 'planned', next: '', context, overwrite: true })

    assert.equal(forced.ok, true, forced.message)
    assert.equal(entriesOf(w, scope(), context)[0].title, 'Mine')
  })

  check('edits', 'an overwrite after a concurrent relink keeps the target and the link of one revision, so a restart reads the body linked and not gone', async () => {
    const inst = memory()
    const w = world(m, inst)
    const save = SAVE()
    const context = await open(save)

    await kept(w, scope(), context, 'body', 100)

    const [first] = entriesOf(w, scope(), context)
    const relinked = await notes.saveNote(w.repo, scope(), { entry: first, title: first.title, status: first.status, next: first.next, target: aim(context, 'body', 200), context })

    assert.equal(relinked.ok, true, relinked.message)

    const refused = await notes.saveNote(w.repo, scope(), { entry: first, title: 'Mine', status: 'blocked', next: 'Later', context })

    assert.equal(refused.code, 'revision-conflict')

    const forced = await notes.saveNote(w.repo, scope(), { entry: first, title: 'Mine', status: 'blocked', next: 'Later', context, overwrite: true })

    assert.equal(forced.ok, true, forced.message)

    const [after] = entriesOf(w, scope(), context)

    assert.equal(after.title, 'Mine')
    assert.equal(after.target.id, 200)
    assert.equal(after.target.name, 'Proxima b')
    assert.equal(after.links[0].id, 200)

    const again = world(m, inst)
    const ids = notes.bodyIdsOf(notes.readNotes(again.repo, scope()).entries)

    assert.deepEqual(ids, [200])

    const [restarted] = entriesOf(again, scope(), await open(save, scope(), { bodyIds: ids }))

    assert.equal(restarted.link.status, 'linked')
    assert.equal(restarted.stale, false)
  })

  check('edits', 'a stale delete is refused and nothing is deleted, and a current delete removes the note', async () => {
    const w = world(m)
    const context = await open(SAVE())

    await kept(w, scope(), context, 'body', 101)

    const [first] = entriesOf(w, scope(), context)

    await notes.saveNote(w.repo, scope(), { entry: first, title: 'Changed', status: 'idea', next: '', context })

    const refused = await notes.deleteNote(w.repo, scope(), first)

    assert.equal(refused.ok, false)
    assert.equal(refused.code, 'revision-conflict')
    assert.equal(entriesOf(w, scope()).length, 1)

    const [fresh] = entriesOf(w, scope())

    assert.equal((await notes.deleteNote(w.repo, scope(), fresh)).ok, true)
    assert.equal(entriesOf(w, scope()).length, 0)
  })

  check('edits', 'a note the adapter refuses is not written: an unknown status, no title, a long title or next action, no object', async () => {
    const w = world(m)
    const context = await open(SAVE())

    for (const extra of [{ status: 'someday' }, { title: '   ' }, { title: 'x'.repeat(notes.TITLE_LENGTH + 1) }, { next: 'x'.repeat(notes.NEXT_LENGTH + 1) }]) {
      const outcome = await keep(w, scope(), context, 'body', 100, extra)

      assert.equal(outcome.ok, false, JSON.stringify(extra).slice(0, 40))
      assert.equal(outcome.code, 'invalid-note')
    }

    const noTarget = await notes.saveNote(w.repo, scope(), { title: 'A plan', status: 'idea', next: '', context })

    assert.equal(noTarget.ok, false)
    assert.equal(noTarget.code, 'invalid-note')
    assert.equal((await notes.saveNote(w.repo, scope(), { title: 'A plan', status: 'idea', next: '', target: { type: 'ship', row: { id: 1 } }, context })).code, 'invalid-note')
    assert.equal(entriesOf(w, scope()).length, 0)
    assert.equal(notes.problemsOf({ title: 'a', status: 'idea', next: '', target: { type: 'body', id: 1, name: 'x', systemId: null, systemName: '', origin: { campaignId: 'c1', branchId: 'b1' } }, extra: 1 }).length, 1)
    const valid = { title: 'a', status: 'idea', next: '', target: { type: 'body', id: 1, name: 'x', systemId: null, systemName: '', origin: { campaignId: 'c1', branchId: 'b1' } } }

    assert.deepEqual(notes.problemsOf(valid), [])
    assert.equal(notes.problemsOf({ ...valid, target: { ...valid.target, origin: undefined } }).length, 1)
    assert.equal(notes.problemsOf({ ...valid, target: { ...valid.target, origin: { campaignId: 'c1' } } }).length, 1)
  })

  check('edits', 'a note is refused where the scenario records cannot be written: no repository, no settled scope, another tab holds the file', async () => {
    const w = world(m)
    const context = await open(SAVE())

    assert.equal((await keep({ repo: null }, scope(), context, 'body', 100)).code, 'no-repository')
    assert.equal((await keep(w, null, context, 'body', 100)).code, 'no-scope')

    const locked = world(m, { ...w.inst, storage: { ...w.inst.storage, writable: () => Promise.resolve(false) } })
    const outcome = await keep(locked, scope(), context, 'body', 100)

    assert.equal(outcome.code, 'not-owner')
    assert.match(outcome.message, /note/)
    assert.equal(entriesOf(w, scope()).length, 0)
  })

  // ---- scope --------------------------------------------------------------------------------------------------------

  check('scope', 'a link is made only against the objects of the race, campaign and branch the note is kept for', async () => {
    const w = world(m)
    const save = SAVE()
    const mine = await open(save)
    const target = aim(mine, 'body', 100)

    for (const [name, context] of [['another race', await open(save, scope('b1', 8))], ['another branch', await open(save, scope('b2'))], ['another campaign', await open(save, scope('b1', 7, 'c2'))], ['no objects', null]]) {
      const outcome = await notes.saveNote(w.repo, scope(), { title: 'A plan', status: 'idea', next: '', target, context })

      assert.equal(outcome.ok, false, name)
      assert.equal(outcome.code, 'link-out-of-scope', name)
    }

    assert.equal(entriesOf(w, scope()).length, 0)
  })

  check('scope', 'a link is made only to an object that is there as it was picked, and of a kind the save gave', async () => {
    const w = world(m)
    const save = SAVE()
    const context = await open(save)
    const target = aim(context, 'fleet', 30)
    const changed = { ...context, objects: { ...context.objects, fleet: new Map([[30, { ...target.row, created: 5 }]]) } }
    const missing = { ...context, objects: { ...context.objects, fleet: new Map() } }
    const unread = { ...context, objects: { ...context.objects, fleet: undefined } }

    for (const [context2, code] of [[changed, 'link-stale'], [missing, 'link-stale'], [unread, 'link-not-read']]) {
      const outcome = await notes.saveNote(w.repo, scope(), { title: 'A plan', status: 'idea', next: '', target, context: context2 })

      assert.equal(outcome.ok, false, code)
      assert.equal(outcome.code, code)
    }
  })

  check('scope', 'the link keeps the name, the system and the branch it was made on, and the object of the save as it is now', async () => {
    const w = world(m)
    const save = SAVE()
    const context = await open(save, scope('b2'))

    await kept(w, scope('b2'), context, 'fleet', 31)

    const [entry] = entriesOf(w, scope('b2'), context)

    assert.deepEqual(entry.target, { type: 'fleet', label: 'Fleet', id: 31, name: '2nd Fleet', systemId: 2, systemName: 'Alpha Centauri', origin: { campaignId: 'c1', branchId: 'b2' } })
  })

  // ---- picker -------------------------------------------------------------------------------------------------------

  check('picker', 'the bodies offered are those of the system picked, the techs those the race has researched unless asked, and every kind is listed by name', async () => {
    const context = await open(SAVE(), scope(), { bodyIds: [], systemId: 1 })
    const names = (type, options) => notes.noteChoices(context.objects, type, options).map((choice) => choice.name)

    assert.deepEqual(names('body', { systemId: 1 }), ['Earth', 'Mars'])
    assert.deepEqual(names('body', { systemId: 2 }), [])
    assert.deepEqual(names('tech'), ['Cargo Hold', 'Cargo Shuttle'])
    assert.deepEqual(names('tech', { researched: false }), ['Cargo Hold', 'Cargo Shuttle', 'Deep Scan'])
    assert.deepEqual(names('colony'), ['Earth Prime', 'Proxima Base'])
    assert.deepEqual(names('fleet'), ['1st Fleet', '2nd Fleet'])
    assert.deepEqual(names('design'), ['Ion Drive A', 'Ion Drive B'])
    assert.match(notes.noteChoices(context.objects, 'colony')[0].text, /Sol$/)
    assert.deepEqual(notes.noteChoices(null, 'body'), [])
  })

  // ---- reads --------------------------------------------------------------------------------------------------------

  check('reads', 'every query the notebook sends is a select, and none names a write', async () => {
    const w = world(m)
    const save = SAVE()
    const context = await open(save, scope(), { bodyIds: [100, 200], systemId: 1 })

    await keepAll(w, scope(), context)

    const [entry] = entriesOf(w, scope(), context)

    await notes.saveNote(w.repo, scope(), { entry, title: 'Edited', status: 'done', next: '', context })
    await notes.deleteNote(w.repo, scope(), entriesOf(w, scope(), context)[0])

    assert.ok(context.database.sent.length >= 7)
    context.database.sent.forEach(({ sql }) => {
      assert.match(sql, /^select /)
      assert.doesNotMatch(sql, /\b(insert|update|delete|drop|alter|create|replace|attach|pragma)\b/i)
    })
  })

  check('reads', 'keeping, editing and deleting a note sends nothing to the save: the repository is given no database', async () => {
    const w = world(m)
    const context = await open(SAVE())
    const sentBefore = context.database.sent.length

    await keepAll(w, scope(), context)

    const [entry] = entriesOf(w, scope(), context)

    await notes.saveNote(w.repo, scope(), { entry, title: 'Edited', status: 'done', next: '', context })
    await notes.deleteNote(w.repo, scope(), entriesOf(w, scope(), context)[0])

    assert.equal(context.database.sent.length, sentBefore)
  })

  check('reads', 'the bodies are read by ID in batches and by system, never all of them', async () => {
    const database = fakeSave(edited(SAVE(), (copy) => {
      for (let id = 1000; id < 2000; id += 1) {
        copy.bodies.push(body(id, `B${id}`, 1, id))
      }
    }))
    const ids = Array.from({ length: 1000 }, (_, index) => 1000 + index)
    const bodies = await notes.loadBodies(database, { GameID: 1, RaceID: 7, bodyIds: ids, systemId: null })

    assert.equal(bodies.size, 1000)
    assert.equal(database.sent.length, Math.ceil(1000 / notes.BODIES_PER_READ))
    database.sent.forEach(({ sql }) => {
      const listed = /SystemBodyID in \(([\d, ]+)\)/.exec(sql)[1].split(',')

      assert.ok(listed.length <= notes.BODIES_PER_READ)
    })

    const none = fakeSave(SAVE())

    assert.equal((await notes.loadBodies(none, { GameID: 1, RaceID: 7 })).size, 0)
    assert.equal(none.sent.length, 0)
    assert.equal((await notes.loadBodies(none, { GameID: 1, RaceID: 7, systemId: 1 })).size, 2)
    assert.equal(none.sent.length, 1)
    assert.equal(none.sent[0].replacements.SystemID, 1)
  })

  check('reads', 'a kind the save cannot give is named as failed and the others are read, and a body read that fails throws so no body is taken for gone', async () => {
    const database = fakeSave(SAVE(), { failing: ['FCT_Population'] })
    const loaded = await notes.loadNoteObjects(database, { GameID: 1, RaceID: 7 })

    assert.match(loaded.failed.colony, /FCT_Population/)
    assert.equal(loaded.objects.colony, undefined)
    assert.equal(loaded.objects.fleet.size, 2)
    assert.equal(loaded.systems.length, 2)
    await assert.rejects(() => notes.loadBodies(fakeSave(SAVE(), { failing: ['FCT_SystemBody'] }), { GameID: 1, RaceID: 7, bodyIds: [100] }), /FCT_SystemBody/)
  })

  // ---- backup -------------------------------------------------------------------------------------------------------

  const annotated = (inst, ids = 0) => {
    const w = world(m, inst)
    const repository = m.records.createRepository({ storage: inst.storage, adapters: w.registry, newId: () => uuid(++ids), now: () => 1000 + ids })

    return { repository, adapter: m.backup.annotationsOf(repository, inst.storage), registry: w.registry }
  }

  check('backup', 'notes round-trip through the backup\'s annotation adapter with their status, next action, link, policy and uuid', async () => {
    const source = annotated(memory(), 0)
    const context = await open(SAVE())
    const make = (type, id, policy, title) => notes.saveNote(source.repository, scope('b1'), { title, status: 'blocked', next: 'wait', target: aim(context, type, id), context, policy })

    await make('body', 100, 'branch', 'on the branch')
    await make('tech', 3, 'campaign', 'on the campaign')

    const bundle = source.adapter.export(scope('b1'))

    assert.equal(bundle.records.length, 2)

    const target = annotated(memory(), 1000)
    const place = { campaignId: 'c1', RaceID: 7, branch: 'b1' }
    const preview = target.adapter.preview(bundle, place, { restore: true })

    assert.equal(preview.items.every((item) => item.status === 'import'), true, JSON.stringify(preview).slice(0, 300))
    assert.equal(target.adapter.import(bundle, place, { preview, restore: true }).imported.length, 2)

    const entries = notes.readNotes(target.repository, scope('b1'), context).entries
    const [branch, campaign] = [entries.find((entry) => entry.title === 'on the branch'), entries.find((entry) => entry.title === 'on the campaign')]

    assert.equal(branch.policy, 'branch')
    assert.equal(campaign.policy, 'campaign')
    assert.equal(branch.status, 'blocked')
    assert.equal(branch.next, 'wait')
    assert.equal(branch.link.status, 'linked')
    assert.equal(campaign.link.status, 'linked')
    assert.deepEqual(entries.map((entry) => entry.uuid).sort(), bundle.records.map((record) => record.uuid).sort())
  })

  check('backup', 'a kind the installation has no adapter for is refused, so a backup needs the notes\' adapter registered', async () => {
    const source = annotated(memory(), 0)

    await kept({ repo: source.repository }, scope('b1'), await open(SAVE()), 'body', 100)

    const bundle = source.adapter.export(scope('b1'))
    const bare = memory()
    const registry = m.records.createAdapterRegistry()
    const repository = m.records.createRepository({ storage: bare.storage, adapters: registry, now: () => 1 })
    const adapter = m.backup.annotationsOf(repository, bare.storage)
    const preview = adapter.preview(bundle, { campaignId: 'c1', RaceID: 7, branch: 'b1' }, { restore: true })

    assert.equal(preview.items.every((item) => item.status === 'rejected'), true)
  })

  // ---- saves --------------------------------------------------------------------------------------------------------

  const sqlite3 = () => localRequire('sqlite3')

  // A save opened read only, with a `database` of the shape the page's reads use, and the SQL it was sent.
  const openSave = (file) => {
    const db = new (sqlite3().Database)(file, sqlite3().OPEN_READONLY)
    const sent = []
    const run = (sql, params = {}) => new Promise((resolve, reject) => db.all(sql, Object.fromEntries(Object.entries(params).map(([key, value]) => [`:${key}`, value])), (error, rows) => (error ? reject(error) : resolve(rows))))

    return { file, sent, close: () => db.close(), run, database: { query: async (sql, { replacements = {} } = {}) => { sent.push(sql); return [await run(sql, replacements)] } } }
  }

  const KNOWN_BODIES = 'select FCT_SystemBody.SystemBodyID from FCT_SystemBody inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = :RaceID and FCT_RaceSysSurvey.GameID = :GameID where FCT_SystemBody.GameID = :GameID and FCT_SystemBody.BodyClass in (1, 2, 3, 5)'

  // The objects of a real save: everything `loadNoteObjects` gives and every body the race knows.
  const objectsOfSave = async (save, GameID, RaceID) => {
    const ids = (await save.run(KNOWN_BODIES, { GameID, RaceID })).map((row) => row.SystemBodyID)
    const loaded = await notes.loadNoteObjects(save.database, { GameID, RaceID })
    const bodies = await notes.loadBodies(save.database, { GameID, RaceID, bodyIds: ids })
    const [{ GameTime }] = await save.run('select GameTime from FCT_Game where GameID = :GameID', { GameID })

    return { objects: notes.withBodies(loaded, bodies).objects, GameTime, failed: loaded.failed }
  }

  // The link a note holds, as the repository stores and lists it, for the object `row` of kind `type` made in `from` and read in `to`: the stored link's status is the repository's (gone, changed or linked by fingerprint), and `resolveLink` gives what the note shows.
  const shown = (type, row, now, context, origin) => {
    const definition = notes.NOTE_TARGETS[type]
    const status = !now ? 'missing' : definition.fingerprint(now) === definition.fingerprint(row) ? 'linked' : 'changed'
    const stored = { type, id: row.id, fingerprint: definition.fingerprint(row), status, ...(now ? { current: definition.fingerprint(now) } : {}) }

    return milestones.resolveLink(stored, { name: row.name, origin }, context, notes.NOTE_TARGETS)
  }

  const falryxFiles = () => (fs.existsSync(FALRYX) ? fs.readdirSync(FALRYX).filter((name) => /^AuroraDB-\d+\.db$/.test(name)).sort() : [])

  check('saves', 'on the owner\'s saves of a rewound game the bodies, colonies, fleets and designed techs whose IDs another branch gave again read as changed or not checked and are never linked', async () => {
    const files = falryxFiles()

    if (files.length < 5) {
      return { skipped: 'the falryx saves are not here' }
    }

    const GameID = 141
    const RaceID = 791
    const [common, a, b] = ['AuroraDB-2713949950.db', 'AuroraDB-2740177930.db', 'AuroraDB-2794985390.db'].map((name) => openSave(path.join(FALRYX, name)))

    try {
      const [before, left, right] = [await objectsOfSave(common, GameID, RaceID), await objectsOfSave(a, GameID, RaceID), await objectsOfSave(b, GameID, RaceID)]
      const parted = before.GameTime
      const tree = { x: { parent: null, t: null }, y: { parent: 'x', t: parted } }
      const context = { objects: right.objects, GameID, RaceID, campaignId: 'c1', branchId: 'y', branches: tree }
      const origin = { campaignId: 'c1', branchId: 'x' }
      const report = {}

      for (const type of Object.keys(notes.NOTE_TARGETS)) {
        const counts = { reissued: 0, linked: 0, unknown: 0, changed: 0, missing: 0, linkedButReissued: 0 }

        for (const [id, row] of left.objects[type]) {
          const now = right.objects[type].get(id) || null
          const result = shown(type, row, now, context, origin)

          counts[result.status] += 1

          if (now && notes.NOTE_TARGETS[type].fingerprint(now) !== notes.NOTE_TARGETS[type].fingerprint(row)) {
            counts.reissued += 1
            const timeLost = type === 'fleet' && Number.isFinite(row.created) && !Number.isFinite(now.created)

            assert.equal(result.status, timeLost ? 'unknown' : 'changed', `${type} ${id}`)
          }

          if (type !== 'tech' && result.status === 'linked') {
            assert.ok(now && notes.NOTE_TARGETS[type].fingerprint(now) === notes.NOTE_TARGETS[type].fingerprint(row), `${type} ${id} is linked though it differs`)
          }

          if (type === 'colony' || type === 'design') {
            assert.notEqual(result.status, 'linked', `${type} ${id}`)
          }
        }

        report[type] = counts
      }

      assert.ok(report.body.reissued > 100, `bodies given again: ${report.body.reissued}`)
      assert.ok(report.colony.reissued > 0, `colonies given again: ${report.colony.reissued}`)
      assert.ok(report.body.linked > 1000)
      assert.equal(report.colony.linked, 0)
      assert.equal(report.design.linked, 0)
      assert.ok(report.tech.linked === 1186 && report.tech.changed === 0, 'the whole catalogue links on the other branch')

      // The evidence the rule rests on: no body of a system found before the last save both branches hold differs on the two branches.
      let early = 0

      for (const [id, row] of left.objects.body) {
        const now = right.objects.body.get(id)

        if (now && row.discovered < parted) {
          early += 1
          assert.equal(notes.NOTE_TARGETS.body.fingerprint(now), notes.NOTE_TARGETS.body.fingerprint(row), `body ${id}`)
        }
      }

      assert.ok(early > 1000)

      const later = Math.min(...[...left.objects.body.values()].filter((row) => right.objects.body.has(row.id) && notes.NOTE_TARGETS.body.fingerprint(right.objects.body.get(row.id)) !== notes.NOTE_TARGETS.body.fingerprint(row)).map((row) => row.discovered))

      assert.ok(later >= parted, 'every body that was given again is in a system found after the saves the branches share')

      return `${report.body.reissued} bodies, ${report.colony.reissued} colonies, ${report.fleet.reissued} fleets, ${report.design.reissued} designed techs given again; none linked`
    } finally {
      ;[common, a, b].forEach((save) => save.close())
    }
  })

  check('saves', 'on the owner\'s saves a note made on one branch is kept, read on the other and edited end to end, with the sample of bodies given again reading changed', async () => {
    const files = falryxFiles()

    if (files.length < 5) {
      return { skipped: 'the falryx saves are not here' }
    }

    const GameID = 141
    const RaceID = 791
    const [a, b] = ['AuroraDB-2740177930.db', 'AuroraDB-2794985390.db'].map((name) => openSave(path.join(FALRYX, name)))

    try {
      const [left, right] = [await objectsOfSave(a, GameID, RaceID), await objectsOfSave(b, GameID, RaceID)]
      const differs = (id) => notes.NOTE_TARGETS.body.fingerprint(right.objects.body.get(id)) !== notes.NOTE_TARGETS.body.fingerprint(left.objects.body.get(id))
      const shared = [...left.objects.body.keys()].filter((id) => right.objects.body.has(id))
      const reissued = shared.filter(differs).slice(0, 12)
      const same = shared.filter((id) => !differs(id) && left.objects.body.get(id).discovered < 2713949950).slice(0, 12)
      const w = world(m)
      const whereX = scope('x', RaceID)
      const contextX = { objects: left.objects, GameID, RaceID, campaignId: 'c1', branchId: 'x', branches: { x: { parent: null, t: null }, y: { parent: 'x', t: 2713949950 } } }

      for (const id of [...reissued, ...same]) {
        await kept(w, whereX, contextX, 'body', id, { policy: 'campaign' })
      }

      const contextY = { objects: right.objects, GameID, RaceID, campaignId: 'c1', branchId: 'y', branches: contextX.branches }
      const entries = entriesOf(w, scope('y', RaceID), contextY)

      assert.equal(entries.length, reissued.length + same.length)
      reissued.forEach((id) => assert.equal(entries.find((entry) => entry.target.id === id).link.status, 'changed', `body ${id}`))
      same.forEach((id) => assert.equal(entries.find((entry) => entry.target.id === id).link.status, 'linked', `body ${id}`))
      assert.ok(reissued.length >= 5 && same.length >= 5)
      assert.equal(entries.filter((entry) => entry.stale).length, reissued.length)

      return `${reissued.length} reissued bodies changed, ${same.length} older ones linked`
    } finally {
      ;[a, b].forEach((save) => save.close())
    }
  })

  check('saves', 'the game\'s own catalogue of techs is the same in two campaigns of two games, and a note on one links in the other', async () => {
    const files = falryxFiles()
    const boscoFiles = fs.existsSync(BOSCO) ? fs.readdirSync(BOSCO).filter((name) => name.endsWith('.db')).sort() : []

    if (files.length < 1 || boscoFiles.length < 1) {
      return { skipped: 'the owner\'s saves are not here' }
    }

    const [falryx, bosco] = [openSave(path.join(FALRYX, files[0])), openSave(path.join(BOSCO, boscoFiles[0]))]

    try {
      const [one, two] = [await objectsOfSave(falryx, 141, 791), await objectsOfSave(bosco, 140, 784)]
      const context = { objects: two.objects, GameID: 140, RaceID: 784, campaignId: 'c2', branchId: 'z', branches: {} }
      let linked = 0

      for (const [id, row] of one.objects.tech) {
        const result = shown('tech', row, two.objects.tech.get(id) || null, context, { campaignId: 'c1', branchId: 'x' })

        assert.equal(result.status, 'linked', `tech ${id}`)
        linked += 1
      }

      assert.equal(one.objects.tech.size, two.objects.tech.size)
      assert.ok(linked > 1000)

      return `${linked} techs link across campaigns`
    } finally {
      ;[falryx, bosco].forEach((save) => save.close())
    }
  })

  check('saves', 'on the owner\'s line of saves the renames keep every link: bodies, fleets and techs stay linked and show the new name, colonies stay not checked and name their holder', async () => {
    const files = fs.existsSync(BOSCO) ? fs.readdirSync(BOSCO).filter((name) => name.endsWith('.db')) : []

    if (files.length < 2) {
      return { skipped: 'the boscodiogigia saves are not here' }
    }

    const GameID = 140
    const RaceID = 784
    const saves = files.map((name) => openSave(path.join(BOSCO, name)))

    try {
      const loaded = []

      for (const save of saves) {
        const [game] = await save.run('select GameTime from FCT_Game where GameID = :GameID', { GameID })

        if (game) {
          loaded.push({ time: game.GameTime, ...(await objectsOfSave(save, GameID, RaceID)) })
        }
      }

      loaded.sort((x, y) => x.time - y.time)
      assert.ok(loaded.length >= 2)

      const renamed = { body: 0, colony: 0, fleet: 0, tech: 0 }
      const origin = { campaignId: 'c1', branchId: 'b1' }

      for (let index = 1; index < loaded.length; index += 1) {
        const [first, second] = [loaded[index - 1], loaded[index]]
        const context = { objects: second.objects, GameID, RaceID, campaignId: 'c1', branchId: 'b1', branches: TREE }

        for (const type of Object.keys(renamed)) {
          for (const [id, row] of first.objects[type]) {
            const now = second.objects[type].get(id)

            if (!now || now.name === row.name || notes.NOTE_TARGETS[type].fingerprint(now) !== notes.NOTE_TARGETS[type].fingerprint(row)) {
              continue
            }

            const result = shown(type, row, now, context, origin)

            renamed[type] += 1

            if (type === 'colony') {
              assert.equal(result.status, 'unknown', `colony ${id}`)
              assert.equal(result.nowNamed, null)
            } else if (type === 'fleet' && !Number.isFinite(row.created)) {
              assert.equal(result.status, 'unknown', `fleet ${id}`)
            } else {
              assert.equal(result.status, 'linked', `${type} ${id}`)
              assert.equal(result.nowNamed, now.name, `${type} ${id}`)
            }
          }
        }
      }

      assert.ok(renamed.body + renamed.colony + renamed.fleet + renamed.tech > 0, 'the saves hold at least one rename')

      return `renames kept: ${renamed.body} bodies, ${renamed.colony} colonies, ${renamed.fleet} fleets, ${renamed.tech} techs`
    } finally {
      saves.forEach((save) => save.close())
    }
  })

  check('saves', 'on the owner\'s saves every query is a select, and reading the objects leaves the file as it was', async () => {
    const files = falryxFiles()

    if (files.length < 1) {
      return { skipped: 'the falryx saves are not here' }
    }

    const file = path.join(FALRYX, files[files.length - 1])
    const digest = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    const before = digest()
    const save = openSave(file)

    try {
      const [first] = await save.run('select SystemID from FCT_RaceSysSurvey where GameID = 141 and RaceID = 791 limit 1')
      const loaded = await notes.loadNoteObjects(save.database, { GameID: 141, RaceID: 791 })
      const bodies = await notes.loadBodies(save.database, { GameID: 141, RaceID: 791, bodyIds: [1988470, 1988471], systemId: first.SystemID })

      assert.deepEqual(loaded.failed, {})
      assert.ok(bodies.size >= 2)
      assert.ok(save.sent.length >= 7)
      save.sent.forEach((sql) => assert.match(sql, /^select /))
    } finally {
      save.close()
    }

    assert.equal(digest(), before)
  })

  return checks
}

// ---- The page --------------------------------------------------------------------------------------------------------

const pageSource = () => fs.readFileSync(pageFile, 'utf8').replace(/\r\n/g, '\n')

const pageSuite = async (m, { mutate = null } = {}) => {
  const options = await loadPage('pages/notebook', { stubs: STUBS, mutate })
  const checks = []
  const check = (name, run) => checks.push({ group: 'page', name, run })
  const { notes } = m

  const mounted = ({ campaign = { campaignId: 'c1', branchId: 'b1', generation: 1 }, RaceID = 7, save = SAVE(), inst = memory(), data = {} } = {}) => {
    const w = world(m, inst)
    const database = fakeSave(save)
    const store = { getters: { config: { get: (_key, fallback) => fallback }, database, GameID: 1, GameTime: 100000, RaceID, 'history/campaign': campaign }, state: { history: { revision: 0 } } }
    const vm = instantiate(options, { $store: store, database, GameID: 1, RaceID, data: { records: { repository: w.repo, error: null }, branches: TREE, ...data } })

    return { vm, w, store, database, save, inst }
  }

  const reads = async (mount) => {
    await mount.vm.runAsync('objectsRead')
    await mount.vm.runAsync('bodiesRead')
    await mount.vm.runAsync('bodiesRead')

    return mount
  }

  // A note made through the form: the kind, the system picked for a body, the object, the title.
  const fill = async (mount, kind, id, { systemId = null, title = 'A plan', status = 'planned', next = 'Next step', campaignWide = false } = {}) => {
    const { vm } = mount

    vm.draft.kind = kind
    vm.draft.systemId = systemId
    await vm.runAsync('bodiesRead')

    const choice = vm.choices.find((one) => one.id === id)

    assert.ok(choice, `the form offers ${kind} ${id}`)
    vm.draft.pick = choice
    vm.draft.title = title
    vm.draft.status = status
    vm.draft.next = next
    vm.draft.campaignWide = campaignWide
  }

  const kept = async (mount, ...args) => {
    await fill(mount, ...args)
    await mount.vm.saveDraft(false)
    await mount.vm.runAsync('bodiesRead')

    assert.equal(mount.vm.message, 'The note is kept.')
  }

  check('every panel names what it is for in the page\'s voice, without the changing figures', () => {
    const text = pageSource()
    const starts = [...text.matchAll(/<v-card class="panel[^"]*"/g)].map((match) => match.index)

    assert.equal(starts.length, 2)
    starts.forEach((start) => {
      const tag = text.slice(start, text.indexOf('>', start))
      const summary = /data-summary="([^"]+)"/.exec(tag)

      assert.ok(summary, 'the start tag carries a data-summary')
      assert.ok(summary[1].length > 60 && summary[1].length < 600)
      assert.doesNotMatch(summary[1], /\b(I|me|my|we|our|you|your)\b/i)
      assert.doesNotMatch(summary[1], /\d/)
      assert.match(text.slice(start, start + 800), /<div class="panel-head">\s*<span>/)
    })
    assert.doesNotMatch(text.slice(0, text.indexOf('<script>')).replace(/<[^>]+>/g, ' '), /\b(I|me|my|we|our|you|your)\b/)
  })

  check('the notebook is a page of the Economy section, and the backup registers its adapter', () => {
    const navigation = fs.readFileSync(navigationFile, 'utf8')
    const history = fs.readFileSync(historyPageFile, 'utf8').replace(/\r\n/g, '\n')
    const start = history.indexOf('The adapter the backup reads and restores')
    const end = history.indexOf('annotationsOf(', start)

    assert.match(navigation, /route: '\/notebook', section: 'economy'/)
    assert.ok(start > 0 && end > start)
    assert.match(history.slice(start, end), /registerEconomyNotes\(records\.registerAdapter\)/)
  })

  check('a note made through the form is kept, listed with its status, next action and link, and the form is emptied', async () => {
    const mount = await reads(mounted())

    await kept(mount, 'body', 101, { systemId: 1, title: 'Terraform Mars', status: 'in-progress', next: 'Send ships' })

    const [entry] = mount.vm.entries

    assert.equal(mount.vm.entries.length, 1)
    assert.equal(entry.title, 'Terraform Mars')
    assert.equal(entry.statusText, 'In progress')
    assert.equal(entry.next, 'Send ships')
    assert.equal(entry.link.status, 'linked')
    assert.equal(entry.link.word, 'linked')
    assert.equal(entry.placeText, 'In Sol')
    assert.equal(mount.vm.draft.title, '')
    assert.equal(mount.vm.draft.uuid, null)
  })

  check('a note about a body is linked again after a restart, the body being read by its ID though no system is picked', async () => {
    const inst = memory()
    const first = await reads(mounted({ inst }))

    await kept(first, 'body', 200, { systemId: 2 })

    const again = await reads(mounted({ inst }))

    assert.equal(again.vm.draft.systemId, null)
    assert.equal(again.vm.entries.length, 1)
    assert.equal(again.vm.entries[0].link.status, 'linked')
    assert.equal(again.vm.entries[0].stale, false)
  })

  check('a body note is never read as gone while its bodies are still being read: the records load after the first read, and the body IDs change with the replacement read pending', async () => {
    const inst = memory()
    const first = await reads(mounted({ inst }))

    await kept(first, 'body', 200, { systemId: 2, title: 'Far body' })

    const again = mounted({ inst, data: { records: null } })

    await again.vm.runAsync('objectsRead')
    await again.vm.runAsync('bodiesRead')
    assert.deepEqual(again.vm.bodyIds, [])
    again.vm.records = { repository: again.w.repo, error: null }
    assert.deepEqual(again.vm.bodyIds, [200])
    assert.equal(again.vm.entries.length, 1)
    assert.equal(again.vm.entries[0].link.status, 'unknown')
    assert.equal(again.vm.entries[0].stale, false)
    assert.equal(again.vm.shown.length, 1)

    await again.vm.runAsync('bodiesRead')
    assert.equal(again.vm.entries[0].link.status, 'linked')
    assert.equal(again.vm.entries[0].stale, false)

    await kept(first, 'body', 100, { systemId: 1, title: 'Near body' })
    again.vm.revision += 1

    const byTitle = (title) => again.vm.entries.find((entry) => entry.title === title)

    assert.equal(again.vm.entries.length, 2)
    assert.equal(byTitle('Near body').link.status, 'unknown')
    assert.equal(byTitle('Near body').stale, false)
    assert.equal(byTitle('Far body').link.status, 'unknown')
    assert.equal(byTitle('Far body').stale, false)

    await again.vm.runAsync('bodiesRead')
    assert.equal(byTitle('Near body').link.status, 'linked')
    assert.equal(byTitle('Near body').stale, false)
    assert.equal(byTitle('Far body').link.status, 'linked')
  })

  check('a renamed target shows its new name and a deleted one stays readable and stale with the name it had', async () => {
    const inst = memory()
    const first = await reads(mounted({ inst }))

    await kept(first, 'fleet', 30, { title: 'Fleet plan' })
    await kept(first, 'tech', 3, { title: 'Tech plan' })
    await kept(first, 'colony', 10, { title: 'Colony plan' })

    const renamed = edited(SAVE(), (copy) => {
      found(copy.fleets, 30).name = 'Home Fleet'
      found(copy.colonies, 10).name = 'New Earth'
      copy.techs = copy.techs.filter((row) => row.id !== 3)
    })
    const again = await reads(mounted({ inst, save: renamed }))
    const byTitle = (title) => again.vm.entries.find((entry) => entry.title === title)

    assert.equal(byTitle('Fleet plan').link.nowNamed, 'Home Fleet')
    assert.equal(byTitle('Fleet plan').stale, false)
    assert.equal(byTitle('Tech plan').stale, true)
    assert.equal(byTitle('Tech plan').target.name, 'Cargo Hold')
    assert.match(byTitle('Tech plan').staleText, /Cargo Hold/)
    assert.equal(byTitle('Colony plan').link.word, 'not checked')
    assert.equal(byTitle('Colony plan').holderName, 'New Earth')
    assert.equal(again.vm.shown.length, 3)
  })

  check('the system filter finds the notes about a body, a colony and a fleet inside the system, and lists the systems that hold notes', async () => {
    const mount = await reads(mounted())

    await kept(mount, 'body', 100, { systemId: 1, title: 'Body plan' })
    await kept(mount, 'colony', 10, { title: 'Colony plan' })
    await kept(mount, 'fleet', 30, { title: 'Fleet plan' })
    await kept(mount, 'fleet', 31, { title: 'Far fleet plan' })
    await kept(mount, 'tech', 3, { title: 'Tech plan' })

    const { vm } = mount

    assert.deepEqual(vm.systemFilter.map((option) => [option.text, option.count]), [['All systems', 5], ['No system', 1], ['Alpha Centauri', 1], ['Sol', 3]])
    vm.filterSystem = 1
    assert.deepEqual(vm.shown.map((entry) => entry.title).sort(), ['Body plan', 'Colony plan', 'Fleet plan'])
    vm.filterSystem = notes.NO_SYSTEM
    assert.deepEqual(vm.shown.map((entry) => entry.title), ['Tech plan'])
    vm.filterSystem = notes.ALL_SYSTEMS
    assert.equal(vm.shown.length, 5)

    vm.filterSystem = 2
    options.watch.systemFilter.call(vm, vm.systemFilter)
    assert.equal(vm.filterSystem, 2)
    await vm.remove(vm.entries.find((entry) => entry.title === 'Far fleet plan'))
    options.watch.systemFilter.call(vm, vm.systemFilter)
    assert.equal(vm.filterSystem, notes.ALL_SYSTEMS)
  })

  check('another race and another branch never list a note, and a note shared with the campaign lists on the other branch', async () => {
    const inst = memory()
    const first = await reads(mounted({ inst }))

    await kept(first, 'body', 100, { systemId: 1, title: 'Branch plan' })
    await kept(first, 'body', 101, { systemId: 1, title: 'Shared plan', campaignWide: true })

    const sameRace = await reads(mounted({ inst }))
    const otherRace = await reads(mounted({ inst, RaceID: 8 }))
    const otherBranch = await reads(mounted({ inst, campaign: { campaignId: 'c1', branchId: 'b2', generation: 1 } }))
    const otherCampaign = await reads(mounted({ inst, campaign: { campaignId: 'c2', branchId: 'b1', generation: 1 } }))

    assert.deepEqual(sameRace.vm.entries.map((entry) => entry.title).sort(), ['Branch plan', 'Shared plan'])
    assert.equal(otherRace.vm.entries.length, 0)
    assert.deepEqual(otherBranch.vm.entries.map((entry) => entry.title), ['Shared plan'])
    assert.equal(otherBranch.vm.entries[0].link.status, 'linked')
    assert.equal(otherCampaign.vm.entries.length, 0)
    assert.equal(otherBranch.vm.scope.branchId, 'b2')
    assert.equal(otherRace.vm.scope.RaceID, 8)
  })

  check('a note is made on the open branch: the objects it is picked from are those of the open save\'s campaign and branch', async () => {
    const mount = await reads(mounted({ campaign: { campaignId: 'c1', branchId: 'b2', generation: 1 } }))

    await kept(mount, 'fleet', 30)
    assert.equal(mount.vm.context.branchId, 'b2')
    assert.deepEqual(mount.vm.entries[0].target.origin, { campaignId: 'c1', branchId: 'b2' })
    assert.equal(notes.readNotes(mount.w.repo, scope('b2')).entries.length, 1)
    assert.equal(notes.readNotes(mount.w.repo, scope('b1')).entries.length, 0)
  })

  check('a draft belongs to the campaign, race and branch it was filled in for: it is dropped when they change and refused when saved after they did', async () => {
    const mount = await reads(mounted())

    await fill(mount, 'fleet', 30, { systemId: null })
    assert.equal(mount.vm.draft.pick.id, 30)
    mount.vm.picked(mount.vm.draft.pick)
    assert.equal(mount.vm.draft.scopeKey, 'c1|7|b1')

    mount.store.getters['history/campaign'] = { campaignId: 'c1', branchId: 'b3', generation: 1 }
    await mount.vm.saveDraft(false)
    assert.match(mount.vm.message, /changed after this form was filled in/)
    assert.equal(notes.readNotes(mount.w.repo, scope('b3')).entries.length + notes.readNotes(mount.w.repo, scope('b1')).entries.length, 0)
    assert.equal(mount.vm.draft.title, '')

    await fill(mount, 'fleet', 30, { systemId: null })
    mount.store.getters['history/campaign'] = { campaignId: 'c1', branchId: 'b1', generation: 1 }
    options.watch.scopeKey.call(mount.vm)
    assert.equal(mount.vm.draft.title, '')
    assert.equal(mount.vm.draft.pick, null)
    assert.match(mount.vm.message, /emptied/)
  })

  check('a note is not kept until an object is picked, and nothing is written for the try', async () => {
    const mount = await reads(mounted())

    mount.vm.draft.kind = 'fleet'
    mount.vm.draft.title = 'No object'
    await mount.vm.saveDraft(false)
    assert.match(mount.vm.message, /Pick the object/)
    assert.equal(notes.readNotes(mount.w.repo, scope()).entries.length, 0)
  })

  check('a stale edit of the form is not written over silently', async () => {
    const mount = await reads(mounted())

    await kept(mount, 'fleet', 30, { title: 'First' })

    const [entry] = mount.vm.entries

    mount.vm.edit(entry)
    mount.vm.draft.title = 'Mine'

    const elsewhere = mount.vm.read.entries[0]

    await notes.saveNote(mount.w.repo, scope(), { entry: elsewhere, title: 'Elsewhere', status: 'idea', next: '', context: mount.vm.context })
    await mount.vm.saveDraft(false)
    assert.ok(mount.vm.conflict)
    assert.equal(mount.vm.conflict.title, 'Elsewhere')
    assert.equal(mount.vm.read.entries[0].title, 'Elsewhere')
    await mount.vm.saveDraft(true)
    assert.equal(mount.vm.read.entries[0].title, 'Mine')
  })

  check('an edit of the form keeps the link, and picking an object relinks the note', async () => {
    const mount = await reads(mounted())

    await kept(mount, 'fleet', 30, { title: 'Fleet plan' })
    mount.vm.edit(mount.vm.entries[0])
    assert.equal(mount.vm.draft.kind, 'keep')
    mount.vm.draft.status = 'done'
    await mount.vm.saveDraft(false)
    assert.equal(mount.vm.entries[0].target.id, 30)
    assert.equal(mount.vm.entries[0].statusText, 'Done')

    mount.vm.edit(mount.vm.entries[0])
    await fill(mount, 'fleet', 31, { title: 'Fleet plan' })
    await mount.vm.saveDraft(false)
    assert.equal(mount.vm.entries[0].target.id, 31)
  })

  check('editing and deleting notes sends nothing but selects to the save', async () => {
    const mount = await reads(mounted())

    await kept(mount, 'fleet', 30)
    mount.vm.edit(mount.vm.entries[0])
    mount.vm.draft.title = 'Edited'
    await mount.vm.saveDraft(false)
    await mount.vm.remove(mount.vm.entries[0])
    assert.equal(mount.vm.entries.length, 0)
    assert.ok(mount.database.sent.length >= 5)
    mount.database.sent.forEach(({ sql }) => assert.match(sql, /^select /))
  })

  check('a read that is still running for another save or race is not used', async () => {
    const mount = await reads(mounted())

    assert.ok(mount.vm.context)

    const otherSave = { ...mount.vm.objectsRead, database: { name: 'another save' } }

    mount.vm.objectsRead = otherSave
    assert.equal(mount.vm.context, null)
    assert.equal(mount.vm.objectsBundle, null)
    mount.vm.objectsRead = { ...otherSave, database: mount.database, RaceID: 99 }
    assert.equal(mount.vm.context, null)
  })

  return checks
}

// ---- Mutants ---------------------------------------------------------------------------------------------------------

const UTILITY_MUTATIONS = [
  { name: 'a link whose object is gone is rebound to the object with the same content', file: 'economy-notes.js', find: 'return objects.get(link.id) || null', replace: 'return objects.get(link.id) || [...objects.values()].find((row) => targetOf(link.type).fingerprint(row) === link.fingerprint) || null', fails: ['links: a link is never rebound'] },
  { name: 'an ID that another object took is trusted', file: 'economy-notes.js', find: "fingerprint: (row) => ['body', present(row.systemId), present(row.planetNumber), present(row.orbitNumber), present(row.bodyClass), present(row.bodyTypeId), present(row.discovered)].join('|'),", replace: "fingerprint: () => 'body',", fails: ['links: an ID that a save gives to another object reads changed', 'saves: on the owner\'s saves of a rewound game'] },
  { name: 'a body is told by its name', file: 'economy-notes.js', find: "fingerprint: (row) => ['body', present(row.systemId),", replace: "fingerprint: (row) => ['body', row.name, present(row.systemId),", fails: ['links: no fingerprint holds a name', 'links: a renamed body, fleet and tech stays linked'] },
  { name: 'a tech is told by its name', file: 'economy-notes.js', find: "fingerprint: (row) => ['tech', present(row.typeId),", replace: "fingerprint: (row) => ['tech', row.name, present(row.typeId),", fails: ['links: no fingerprint holds a name', 'links: a renamed body, fleet and tech stays linked'] },
  { name: 'a body is not told by its place', file: 'economy-notes.js', find: "present(row.planetNumber), present(row.orbitNumber), present(row.bodyClass), present(row.bodyTypeId), present(row.discovered)].join('|'),", replace: "present(row.discovered)].join('|'),", fails: ['links: an ID that a save gives to another object reads changed', 'saves: on the owner\'s saves of a rewound game'] },
  { name: 'a stale note shows no name', file: 'economy-notes.js', find: 'id: target.id, name: target.name, systemId: target.systemId, systemName: target.systemName, origin: { campaignId: target.origin.campaignId', replace: "id: target.id, name: link && (link.status === 'missing' || link.status === 'changed') ? '' : target.name, systemId: target.systemId, systemName: target.systemName, origin: { campaignId: target.origin.campaignId", fails: ['stale: a deleted target leaves the note readable', 'stale: a changed link is stale too', 'stale: a stale note is read the same after a restart'] },
  { name: 'a changed link is not stale', file: 'economy-notes.js', find: "const stale = Boolean(link) && (link.status === 'missing' || link.status === 'changed')", replace: "const stale = Boolean(link) && link.status === 'missing'", fails: ['stale: a changed link is stale too', 'links: an ID that a save gives to another object reads changed'] },
  { name: 'a link that is not checked is stale', file: 'economy-notes.js', find: "const stale = Boolean(link) && (link.status === 'missing' || link.status === 'changed')", replace: "const stale = Boolean(link) && link.status !== 'linked'", fails: ['stale: a note that is not checked is not stale', 'links: a body, a fleet and a catalogue tech are linked'] },
  { name: 'a note is listed on another branch than its own', file: 'economy-notes.js', find: 'listed = repository.list(scope, { kind: NOTE_KIND, context: context || undefined })', replace: "listed = repository.list({ ...scope, branchId: 'b1' }, { kind: NOTE_KIND, context: context || undefined })", fails: ['isolation: a note is kept for its branch by default'] },
  { name: 'a note is listed for another race than its own', file: 'economy-notes.js', find: 'listed = repository.list(scope, { kind: NOTE_KIND, context: context || undefined })', replace: 'listed = repository.list({ ...scope, RaceID: 7 }, { kind: NOTE_KIND, context: context || undefined })', fails: ['isolation: a race lists only its own notes'] },
  { name: 'a note is listed for another campaign than its own', file: 'economy-notes.js', find: 'listed = repository.list(scope, { kind: NOTE_KIND, context: context || undefined })', replace: "listed = repository.list({ ...scope, campaignId: 'c1' }, { kind: NOTE_KIND, context: context || undefined })", fails: ['isolation: another campaign lists none of the notes of this one'] },
  { name: 'a new note is shared with the whole campaign whatever is asked', file: 'economy-notes.js', find: "policy: policy || 'branch', links", replace: "policy: 'campaign', links", fails: ['isolation: a note is kept for its branch by default', 'edits: a note is made with a title'] },
  { name: 'the system filter misses the bodies', file: 'economy-notes.js', find: 'return entries.filter((entry) => entry.place.systemId === systemId)\n}', replace: "return entries.filter((entry) => entry.place.systemId === systemId && entry.target.type !== 'body')\n}", fails: ['filter: the notes of a system are the notes about its bodies', 'filter: the filter finds a linked body and a linked fleet'] },
  { name: 'the system filter misses the fleets', file: 'economy-notes.js', find: 'return entries.filter((entry) => entry.place.systemId === systemId)\n}', replace: "return entries.filter((entry) => entry.place.systemId === systemId && entry.target.type !== 'fleet')\n}", fails: ['filter: the notes of a system are the notes about its bodies', 'filter: the filter finds a linked body and a linked fleet'] },
  { name: 'the system filter misses the colonies', file: 'economy-notes.js', find: 'return entries.filter((entry) => entry.place.systemId === systemId)\n}', replace: "return entries.filter((entry) => entry.place.systemId === systemId && entry.target.type !== 'colony')\n}", fails: ['filter: the notes of a system are the notes about its bodies'] },
  { name: 'a fleet is found in the system it was kept in, not the one it is in', file: 'economy-notes.js', find: 'return { systemId: row.systemId || null, systemName: row.systemName || \'\', lastKnown: false }', replace: 'return { systemId: target.systemId, systemName: target.systemName, lastKnown: false }', fails: ['filter: a fleet that moved is found in the system it is in now'] },
  { name: 'a stale note is found in no system', file: 'economy-notes.js', find: 'return { systemId: target.systemId, systemName: target.systemName, lastKnown: true }', replace: "return { systemId: null, systemName: '', lastKnown: true }", fails: ['filter: a note that is stale, or whose fleet is not known'] },
  { name: 'a fleet that is not known to be the one linked is found where it is now', file: 'economy-notes.js', find: "(link.status === 'linked' || Boolean(targetOf(target.type) && targetOf(target.type).placed))", replace: 'true', fails: ['filter: a note that is stale, or whose fleet is not known'] },
  { name: 'a catalogue tech is not certified on another branch', file: 'history-milestones.js', find: "definition.identity === 'content' || definition.identity === 'static'", replace: "definition.identity === 'content'", fails: ['links: a catalogue tech is linked on any branch', 'saves: the game\'s own catalogue of techs'] },
  { name: 'a designed tech is certified like a catalogue tech', file: 'economy-notes.js', find: "identity: 'unwitnessed',\n    unwitnessedNote:", replace: "identity: 'static',\n    unwitnessedNote:", fails: ['links: a body, a fleet and a catalogue tech are linked', 'saves: on the owner\'s saves of a rewound game'] },
  { name: 'a colony is certified by the place it was made with', file: 'history-milestones.js', find: "if (definition.identity === 'unwitnessed') {\n    return definition.unwitnessedNote || UNVERIFIED_TEXT.unwitnessed\n  }", replace: "if (definition.identity === 'unwitnessed') {\n    return null\n  }", fails: ['links: a body, a fleet and a catalogue tech are linked', 'links: a colony ID given again', 'saves: on the owner\'s saves of a rewound game'] },
  { name: 'a body is certified without the time its system was found', file: 'economy-notes.js', find: "identity: 'created',\n    created: 5,", replace: "identity: 'static',", fails: ['links: on another branch a body is linked only when its system was found strictly before'] },
  { name: 'a body is certified by the time of the wrong part of its fingerprint', file: 'economy-notes.js', find: 'created: 5,', replace: 'created: 4,', fails: ['links: on another branch a body is linked only when its system was found strictly before'] },
  { name: 'a kind of object the save could not give reads as gone', file: 'economy-notes.js', find: 'throw new TypeError(`the #{link.type} objects of the save were not read`)', replace: 'return null', fails: ['links: a link read with no objects is not checked'] },
  { name: 'bodies that are not read yet read as gone', file: 'economy-notes.js', find: 'export const withBodies = (loaded, bodies) => (loaded && bodies instanceof Map ? { ...loaded, objects: { ...loaded.objects, body: bodies } } : loaded)', replace: 'export const withBodies = (loaded, bodies) => (loaded ? { ...loaded, objects: { ...loaded.objects, body: bodies instanceof Map ? bodies : new Map() } } : loaded)', fails: ['links: a link read with no objects is not checked'] },
  { name: 'a link is made against whatever the form holds', file: 'economy-notes.js', find: "const checked = target ? checkLink(context, scope, target, NOTE_TARGETS, 'note') : null", replace: 'const checked = target ? { ok: true, row: target.row } : null', fails: ['scope: a link is made only against the objects of the race', 'scope: a link is made only to an object that is there as it was picked'] },
  { name: 'a link is made against the objects of another race', file: 'history-milestones.js', find: 'context.RaceID !== scope.RaceID', replace: 'false', fails: ['scope: a link is made only against the objects of the race'] },
  { name: 'a link is made against the objects of another campaign or branch', file: 'history-milestones.js', find: ' || context.campaignId !== scope.campaignId || context.branchId !== scope.branchId) {', replace: ') {', fails: ['scope: a link is made only against the objects of the race'] },
  { name: 'a link is made to an object that is not as it was picked', file: 'history-milestones.js', find: 'if (!current || linkTypeOf(link.type, types).fingerprint(current) !== linkTypeOf(link.type, types).fingerprint(link.row)) {', replace: 'if (!current) {', fails: ['scope: a link is made only to an object that is there as it was picked'] },
  { name: 'the link does not keep the branch it was made on', file: 'economy-notes.js', find: 'origin: { campaignId: scope.campaignId, branchId: scope.branchId } } : keptTarget(entry, context)', replace: "origin: { campaignId: scope.campaignId, branchId: 'b1' } } : keptTarget(entry, context)", fails: ['scope: the link keeps the name, the system and the branch'] },
  { name: 'a note with no origin of its link is read', file: 'economy-notes.js', find: ' && isObject(target.origin) && isText(target.origin.campaignId) && isText(target.origin.branchId)', replace: '', fails: ['edits: a note the adapter refuses is not written'] },
  { name: 'an edit without a link drops the link the note has', file: 'economy-notes.js', find: '...(target ? { links } : {}),', replace: '...{ links },', fails: ['edits: an edit changes the fields it names', 'stale: a stale note is edited without a new link'] },
  { name: 'a stale edit is written over without asking', file: 'economy-notes.js', find: "      if (!overwrite) {\n        return { ok: false, code: 'revision-conflict', message: error.message, stored: copyOf(error.stored.payload), revision: error.stored.revision }\n      }\n\n", replace: '', fails: ['edits: a stale edit is refused'] },
  { name: 'an overwrite keeps the target of the edited entry beside the link the store holds', file: 'economy-notes.js', find: 'target ? patch : { ...patch, payload: { ...payload, target: copyOf(error.stored.payload.target) } }', replace: 'patch', fails: ['edits: an overwrite after a concurrent relink'] },
  { name: 'an edit does not write the name the object has now', file: 'economy-notes.js', find: 'name: row ? row.name : kept.name,', replace: 'name: kept.name,', fails: ['stale: an edit while the link holds writes the name'] },
  { name: 'an edit writes the name of whatever holds the ID now', file: 'economy-notes.js', find: "const row = entry.link && entry.link.status === 'linked' ? currentRowOf(context, kept) : null", replace: 'const row = currentRowOf(context, kept)', fails: ['stale: a changed link is stale too'] },
  { name: 'the picker offers every tech', file: 'economy-notes.js', find: "(type !== 'tech' || !researched || row.researched)", replace: 'true', fails: ['picker: the bodies offered'] },
  { name: 'the picker offers the bodies of every system', file: 'economy-notes.js', find: "(type !== 'body' || row.systemId === systemId)", replace: 'true', fails: ['picker: the bodies offered'] },
  { name: 'the bodies are read all at once', file: 'economy-notes.js', find: 'for (const batch of batchesOf(bodyIds.filter((id) => Number.isInteger(id)), BODIES_PER_READ)) {', replace: 'for (const batch of batchesOf(bodyIds.filter((id) => Number.isInteger(id)), 100000)) {', fails: ['reads: the bodies are read by ID in batches'] },
  { name: 'a failed read of the bodies is taken for no bodies', file: 'economy-notes.js', find: '    keep((await database.query(bodiesByIdSql(batch), { replacements }))[0])', replace: '    keep((await database.query(bodiesByIdSql(batch), { replacements }).catch(() => [[]]))[0])', fails: ['reads: a kind the save cannot give is named as failed'] },
  { name: 'a failed read of one kind of object stops the others', file: 'economy-notes.js', find: 'failed[key] = messageOf(error)', replace: 'throw error', fails: ['reads: a kind the save cannot give is named as failed', 'links: a link read with no objects is not checked'] },
  { name: 'a write is sent to the save', file: 'economy-notes.js', find: '  return bodies\n}', replace: "  await database.query('update FCT_SystemBody set SystemBodyID = SystemBodyID')\n\n  return bodies\n}", fails: ['reads: every query the notebook sends is a select', 'saves: on the owner\'s saves every query is a select'] },
  { name: 'keeping a note writes to the save', file: 'economy-notes.js', find: '    const links = target ? [{ type: target.type, id: row.id, row }] : []', replace: "    const links = target ? [{ type: target.type, id: row.id, row }] : []\n\n    if (context && context.database) {\n      await context.database.query('delete from FCT_Fleet where FleetID = 0')\n    }", fails: ['reads: keeping, editing and deleting a note sends nothing to the save', 'reads: every query the notebook sends is a select'] },
]

const PAGE_MUTATIONS = [
  { name: 'the page reads the notes of another race', mutate: replacing('scopeOf({ campaign: this.resolved, RaceID: this.RaceID, gameTime: this.GameTime })', 'scopeOf({ campaign: this.resolved, RaceID: 7, gameTime: this.GameTime })'), fails: ['page: another race and another branch never list a note'] },
  { name: 'the page reads the notes of another branch', mutate: replacing('scopeOf({ campaign: this.resolved, RaceID: this.RaceID, gameTime: this.GameTime })', "scopeOf({ campaign: this.resolved, RaceID: this.RaceID, branchId: 'b1', gameTime: this.GameTime })"), fails: ['page: another race and another branch never list a note', 'page: a note is made on the open branch'] },
  { name: 'the objects are checked against the branch of another save', mutate: replacing('branchId: open.branchId, branches: this.branches }', "branchId: 'b1', branches: this.branches }"), fails: ['page: a note is made on the open branch'] },
  { name: 'the page does not hand the lineage to the links', mutate: replacing('branchId: open.branchId, branches: this.branches }', 'branchId: open.branchId }'), fails: ['page: another race and another branch never list a note'] },
  { name: 'the system filter is not applied', mutate: replacing('return filterBySystem(this.entries, this.filterSystem)', 'return this.entries'), fails: ['page: the system filter finds the notes'] },
  { name: 'the filter keeps a system that holds no note', mutate: replacing('if (!options.some((option) => option.value === this.filterSystem)) {', 'if (false) {'), fails: ['page: the system filter finds the notes'] },
  { name: 'the bodies the notes link to are not read', mutate: replacing('const bodyIds = this.bodyIds', 'const bodyIds = []'), fails: ['page: a note about a body is linked again after a restart', 'page: a body note is never read as gone'] },
  { name: 'the objects read for another save, game or race are used', mutate: replacing('return bundle && bundle.database === this.database && bundle.GameID === this.GameID && bundle.RaceID === this.RaceID ? bundle : null\n    },\n\n    // The bodies as read for the save', 'return bundle\n    },\n\n    // The bodies as read for the save'), fails: ['page: a read that is still running for another save or race is not used'] },
  { name: 'a read of the bodies made for other IDs counts as the read for the IDs now', mutate: replacing(' && this.bodyIds.every((id) => bundle.requested.has(id))', ''), fails: ['page: a body note is never read as gone'] },
  { name: 'a read of the bodies is taken as asking for every ID', mutate: replacing('requested: new Set(bodyIds) })\n        } catch', 'requested: { has: () => true } })\n        } catch'), fails: ['page: a body note is never read as gone'] },
  { name: 'a draft is saved for another campaign, race or branch than it was filled in for', mutate: replacing('if (draft.scopeKey !== null && draft.scopeKey !== this.scopeKey) {', 'if (false) {'), fails: ['page: a draft belongs to the campaign'] },
  { name: 'a draft is kept when what is shown changes', mutate: replacing('resetDraft() {\n      this.draft = blankDraft()', 'resetDraft() {\n      this.draft = this.draft'), fails: ['page: a draft belongs to the campaign'] },
  { name: 'an edit is made over the revision the list has now, so a stale one is written over', mutate: replacing('{ ...stored, revision: draft.revision }', 'stored'), fails: ['page: a stale edit of the form is not written over silently'] },
  { name: 'a note is kept for the campaign whatever the switch says', mutate: replacing("policy: draft.campaignWide ? 'campaign' : 'branch'", "policy: 'campaign'"), fails: ['page: another race and another branch never list a note'] },
  { name: 'the form relinks a note when it is only edited', mutate: replacing("const target = draft.kind === 'keep' ? undefined : { type: draft.kind, row: draft.pick.row }", 'const target = { type: draft.kind, row: draft.pick.row }'), fails: ['page: an edit of the form keeps the link'] },
  { name: 'a note is kept with no object picked', mutate: replacing("if (draft.kind !== 'keep' && !draft.pick) {", 'if (false) {'), fails: ['page: a note is not kept until an object is picked'] },
]

const mutatedCopy = ({ file, find, replace }) => {
  const from = unhashed(find)
  const to = unhashed(replace)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-economy-notes-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')

  if (source.split(from).length !== 2) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw new Error(`The mutation must apply exactly once to ${file}: ${from}`)
  }

  fs.writeFileSync(target, source.replace(from, () => to))

  return directory
}

const loadModules = async (directory) => {
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, directory })

  return { notes: loaded['economy-notes'], milestones: loaded['history-milestones'], records: loaded['scenario-records'], backup: loaded['history-backup'] }
}

let failures = 0
let total = 0
let skipped = 0

const show = (name, result, detail = '', skip = false) => {
  if (skip) {
    skipped++
    console.log(`SKIP  ${name}  [${detail}]`)

    return
  }

  const ok = result === true

  total++

  if (!ok) {
    failures++
  }

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? (detail ? `  [${detail}]` : '') : `\n         ${typeof result === 'string' ? result : 'false'}`}`)
}

const runChecks = async (list, only = null) => {
  const results = []

  for (const { group, name, run } of list) {
    if (only && !only.some((start) => `${group}: ${name}`.startsWith(start))) {
      continue
    }

    try {
      const detail = await run()

      if (detail && typeof detail === 'object' && detail.skipped) {
        results.push([`${group}: ${name}`, true, detail.skipped, true])
      } else {
        results.push([`${group}: ${name}`, true, typeof detail === 'string' ? detail : '', false])
      }
    } catch (error) {
      results.push([`${group}: ${name}`, String((error && error.stack) || error).split('\n').slice(0, 7).join('\n         '), '', false])
    }
  }

  return results
}

const caught = (mutant, results) => {
  const expected = mutant.fails.filter((start) => !results.some(([name, , , skip]) => skip && name.startsWith(start)))
  const survived = expected.filter((start) => !results.some(([name, result]) => name.startsWith(start) && result !== true))
  const missing = expected.filter((start) => !results.some(([name]) => name.startsWith(start)))

  return survived.length === 0 && missing.length === 0 ? true : `${missing.length ? `no check starts with: ${missing.join('; ')}. ` : ''}${survived.length ? `these checks still pass: ${survived.join('; ')}` : ''}`
}

const RESULT = 'RESULT '
const MUTANTS = [...UTILITY_MUTATIONS.filter((entry) => entry.fails.length).map((mutant) => ({ mutant, page: false })), ...PAGE_MUTATIONS.map((mutant) => ({ mutant, page: true }))]

// What the baseline, each mutant and the control print, as entries a child hands to the parent: a line of text, or the arguments of `show`.
const baselineEntries = async () => {
  const real = await loadModules(utilitiesDirectory)
  const entries = [{ log: 'The notebook: links, stale notes, the system filter, isolation, edits, scope, reads, backup and the owner\'s saves' }]

  for (const [name, result, detail, skip] of await runChecks(suite(real))) {
    entries.push({ show: [name, result, detail, skip] })
  }

  entries.push({ log: '\nThe Notebook page (its script over scripts/lib/page-loader.js)' })

  for (const [name, result] of await runChecks(await pageSuite(real))) {
    entries.push({ show: [name, result] })
  }

  return entries
}

const mutantEntries = async ({ mutant, page }) => {
  let directory = null

  try {
    let results = null

    if (page) {
      results = await runChecks(await pageSuite(await loadModules(utilitiesDirectory), { mutate: mutant.mutate }), mutant.fails)
    } else {
      directory = mutatedCopy(mutant)
      results = await runChecks(suite(await loadModules(directory)), mutant.fails)
    }

    return [{ show: [`mutant caught: ${mutant.name}`, caught(mutant, results)] }]
  } catch (error) {
    return [{ show: [`mutant caught: ${mutant.name}`, error.message] }]
  } finally {
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

const controlEntries = async () => {
  const real = await loadModules(utilitiesDirectory)
  const control = await runChecks(suite(real), [...new Set(UTILITY_MUTATIONS.flatMap((mutant) => mutant.fails))])
  const controlPage = await runChecks(await pageSuite(real), [...new Set(PAGE_MUTATIONS.flatMap((mutant) => mutant.fails))])
  const wrong = [...control, ...controlPage].filter(([, result]) => result !== true).map(([name]) => name)

  return [{ show: ['a control run of the unchanged code passes every check the mutants name', wrong.length === 0 ? true : `fails ${wrong.join('; ')}`] }]
}

// A child runs the baseline (`--baseline`), the control (`--control`) or some mutants in turn (`--mutants=<i>,<i>`) in a process of its own, so no chunk shares the modules or the stores of another, and prints its entries as JSON on its last line: those of the baseline or the control, or the list of the entries of each mutant.
const childMain = async () => {
  const given = process.argv.find((argument) => argument.startsWith('--mutants='))
  let entries = null

  if (given) {
    entries = []

    for (const index of given.slice('--mutants='.length).split(',')) {
      entries.push(await mutantEntries(MUTANTS[Number(index)]))
    }
  } else {
    entries = process.argv.includes('--control') ? await controlEntries() : await baselineEntries()
  }

  process.stdout.write(`${RESULT}${JSON.stringify(entries)}\n`, () => process.exit(0))
}

const main = async () => {
  if (['--baseline', '--control'].some((flag) => process.argv.includes(flag)) || process.argv.some((argument) => argument.startsWith('--mutants='))) {
    return childMain()
  }

  const mutating = !process.argv.includes('--no-mutations')
  const chunks = mutating ? chunksOf(MUTANTS.length) : []
  const items = [['--baseline'], ...(mutating ? [['--control'], ...chunks.map((list) => [`--mutants=${list.join(',')}`])] : [])]
  const outcomes = await inParallel(items, async (args) => lastJson(await runChild(__filename, args), RESULT))
  const replay = (entries) => entries.forEach((entry) => (entry.log !== undefined ? console.log(entry.log) : show(...entry.show)))

  if (outcomes[0] instanceof Error) {
    throw outcomes[0]
  }

  replay(outcomes[0])

  if (mutating) {
    console.log('\nmutants')

    spread(chunks, outcomes.slice(2)).forEach((outcome, index) => (outcome instanceof Error ? show(`mutant caught: ${MUTANTS[index].mutant.name}`, `does not run: ${outcome.message}`) : replay(outcome)))

    if (outcomes[1] instanceof Error) {
      show('a control run of the unchanged code passes every check the mutants name', `does not run: ${outcomes[1].message}`)
    } else {
      replay(outcomes[1])
    }
  }

  console.log(`\n${total - failures} of ${total} checks passed${skipped ? ` (${skipped} skipped: the owner's saves are not here)` : ''}`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
