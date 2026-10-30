/*
  Checks the personal tags on bodies (utilities/world-tags.js, mixins/world-tags.js, components/notebook/WorldTags.vue) and their two homes, the Notebook and the Galaxy Map (pages/map.vue): a short label the player puts on one planet, moon, asteroid or comet of a known system, kept in the scenario repository for a campaign, race and branch, and filtered by tag on both pages.

  node scripts/check-world-tags.js [--no-mutations]

  WORLD_TAGS_BOSCO points the saves checks at a folder of saves (or at none: a folder that is not there skips them). A check that needs the owner's saves and does not find them is reported as skipped, is not counted, and no mutant is expected to fail it.

  Groups:
  - moon: a tag is on the body it was put on, so tagging a moon leaves its planet and its system untagged and the other way round, and nothing but the campaign's scenario file is written;
  - known: a body is known when its system is, surveyed or not, so a body of an unknown system is refused and the picker offers the bodies of the system picked with their class;
  - edit: a tag is made, changed (its text trimmed and its spaces collapsed) and cleared, a body has one tag, the same text changes nothing, an invalid tag and a stale edit are refused, and a stale tag can still be changed;
  - stale: a gone body, a changed one and a body that holds an ID again leave the tag listed as stale with the name and system it had, a rename keeps the link, nothing is ever relinked by name or place, and a body that is not read is not checked, never gone;
  - rewind: a save from before the system was found reads the tag as gone or changed and says the save is from before the tag, with the time the system was found, and the tag matches again in a later save;
  - isolation: another race, branch or campaign never lists a tag, the notes and the tags are kinds of their own, and the tags live through a restart;
  - filter: the tag filter finds a tag by its text (the words all and stale are ordinary tags), lists a stale tag under its text and under Stale tags, and groups the tags by system for the map;
  - scope: a tag is made only against the bodies of the race, campaign and branch it is kept for and only for a body that is there as it was picked, and keeps the branch it was made on;
  - reads: every query is a select, so keeping, changing and clearing a tag never writes the save;
  - backup: tags round-trip through the backup's annotation adapter, and the adapter is for bodies only;
  - saves: on the owner's saves (opened read only, skipped when they are not here) a body that was never surveyed is taggable, a body of an unknown system is not, a moon leaves its planet untagged, a save from before a system was found shows the mismatch and the file is as it was;
  - mixin: the code the Notebook and the Map share lists, filters, keeps and isolates the tags of the race and branch shown, and a body that is not read or whose read failed is never taken for gone;
  - component: the rows say why a tag is stale and what a save from before it means, and the form is dropped when what is shown changes;
  - map: the glyph, its stale form, the dimming, the filter, the panel and the mark of the Galaxy Map, and that tagging never changes a cluster, a pin or a border.

  Everything runs on in-memory stores, the real scenario repository and a fake save that records the SQL it is sent. Each mutation of the code must fail the checks it names. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createRequire } = require('module')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate } = require('./lib/page-loader')
const { patched } = require('./lib/mutant-source')
const { inParallel, runChild, lastJson } = require('./lib/check-pool')
const { chunksOf, spread } = require('./lib/mutant-chunks')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const mixinFile = path.join(root, 'src', 'renderer', 'mixins', 'world-tags.js')
const BOSCO = process.env.WORLD_TAGS_BOSCO || path.join(root, 'artifacts', 'boscodiogigia-sequential-saves')
const NAMES = ['world-tags', 'economy-notes', 'history-milestones', 'scenario-records', 'history-backup']

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`
const real = (specifier) => `import { createRequire } from 'node:module'\nexport default ${requireOf(specifier)}`

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  electron: 'export const ipcRenderer = { invoke: () => Promise.resolve(null) }',
  dayjs: real('dayjs'),
  'dayjs/plugin/utc.js': real('dayjs/plugin/utc.js'),
  romanum: real('romanum'),
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
  'lodash/groupBy': real('lodash/groupBy'),
  vue: 'export default { observable: (value) => value }',
  cytoscape: 'const cytoscape = () => ({}); cytoscape.use = () => {}; export default cytoscape',
  'cytoscape-cxtmenu': 'export default {}',
  'cytoscape-fcose': 'export default {}',
  'cytoscape-cola': 'export default {}',
}

const FONT_ROLES = "({ family: 'Test, sans-serif', svg: 'Test', map: 'Test, sans-serif', chart: 'Test, sans-serif', scale: 1, size: (px) => px })"

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

const localRequire = createRequire(path.join(root, 'package.json'))

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const unhashed = (text) => text.replace(/#\{/g, '$' + '{')

// ---- Fixtures --------------------------------------------------------------------------------------------------------

// The stores of one installation: each a JSON value read and written whole, as electron-store's `.store` is, with the store client's whole-file `update`.
// A tag made over what the body has now, as a form that picked the body a moment ago: the expectation is read from the stored tags unless a check gives one.
const saveNow = (tags, repository, where, args) => tags.saveTag(repository, where, args.target && args.expected === undefined ? { ...args, expected: tags.expectedOf(tags.readTags(repository, where, args.context).entries, args.target.row) } : args)

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
  m.tags.registerWorldTags(registry.register)

  const make = (extra = {}) => m.records.createRepository({ storage: inst.storage, adapters: registry, newId: () => uuid(++ids), now: () => ++clock, ...extra })

  return { inst, registry, make, repo: make() }
}

// The app's own store host and store client (src/main/store-host.js, src/preload/store-client.js) over in-memory files: `window(hook)` is the storage of one window, whose requests call `hook(request)` before the host answers.
const hosted = (m) => {
  const files = new Map()
  const host = m.host.createStoreHost((options) => {
    const key = `${options.cwd || ''}/${options.name || 'config'}`

    return {
      get store () {
        return clone(files.get(key)) || {}
      },
      set store (value) {
        files.set(key, clone(value))
      },
      get path () {
        return key
      },
    }
  })

  const window = (hook = null) => {
    const Remote = m.client.createStoreClient((request) => {
      if (hook) {
        hook(request)
      }

      return host.handle(request)
    })

    return { storage: { open: (campaignId) => new Remote({ cwd: 'scenarios', name: m.records.scenarioFileName(campaignId) }), writable: () => Promise.resolve(true) } }
  }

  return { files, window }
}

// Two windows over one installation: `first` is the window under test and `other` the repository of a second one. Once `arm()` is called, `rival(other)` is the second window's write, made when `first` asks for its first compare-and-swap, so it lands between the read of `first` and its swap; `swaps()` counts the swaps `first` asked for since then.
const interleaved = (m, rival) => {
  const hosting = hosted(m)
  let ids = 9000
  let swaps = 0
  let armed = false
  const other = world(m, hosting.window()).make({ newId: () => uuid(++ids) })
  const firstInst = hosting.window((request) => {
    if (armed && request.op === 'swap' && ++swaps === 1) {
      rival(other)
    }
  })

  return { firstInst, first: world(m, firstInst), other, arm: () => { armed = true; swaps = 0 }, swaps: () => swaps }
}

// The writes a second window makes: a tag made on a body, the text of the body's tag changed, and the tag cleared.
const rivalCreate = (m, where, context, id, text) => (repository) => {
  const row = context.objects.body.get(id)

  repository.create(where, { kind: m.tags.TAG_KIND, policy: 'branch', links: [{ type: 'body', id: row.id, row }], payload: { tag: text, target: { type: 'body', id: row.id, name: row.name, systemId: row.systemId || null, systemName: row.systemName || '', origin: { campaignId: where.campaignId, branchId: where.branchId } } } })
}

const rivalChange = (m, where, context, text) => (repository) => {
  const [one] = m.tags.readTags(repository, where, context).entries

  repository.update(where, one.uuid, one.revision, { payload: { tag: text, target: one.target } })
}

const rivalClear = (m, where, context) => (repository) => {
  const [one] = m.tags.readTags(repository, where, context).entries

  repository.delete(where, one.uuid, one.revision)
}

const scope = (branchId = 'b1', RaceID = 7, campaignId = 'c1', gameTime = 100000) => ({ campaignId, RaceID, branchId, gameTime })

// The branches of the campaign c1 as the registry holds them (`branchLineage`).
const TREE = { b1: { parent: null, t: null }, b2: { parent: 'b1', t: 1000 }, b3: { parent: 'b1', t: 3000 }, b4: { parent: 'b1', t: null } }

// ---- A fake save: the tables the queries of the tags read ------------------------------------------------------------

const system = (id, name, discovered) => ({ id, name, discovered })

const body = (id, name, systemId, planet = 1, orbit = 0, bodyClass = 1, bodyType = 2) => ({ id, name, systemId, planet, orbit, bodyClass, bodyType })

// Sol holds a planet with a moon, a second planet, an asteroid and a comet; Alpha Centauri holds a planet; system 3 is not known to the race.
const EARTH = 100
const MARS = 101
const LUNA = 102
const CERES = 103
const HALLEY = 104
const PROXIMA = 200
const HIDDEN = 300

const SAVE = () => ({
  systems: [system(1, 'Sol', 500), system(2, 'Alpha Centauri', 2000)],
  bodies: [body(EARTH, 'Earth', 1, 3), body(MARS, 'Mars', 1, 4), body(LUNA, 'Luna', 1, 3, 1, 2, 6), body(CERES, 'Ceres', 1, 5, 0, 3, 9), body(HALLEY, 'Halley', 1, 0, 0, 5, 10), body(PROXIMA, 'Proxima b', 2, 2), body(HIDDEN, 'Hidden', 3, 1)],
})

const edited = (save, change) => {
  const copy = clone(save)

  change(copy)

  return copy
}

const found = (list, id) => list.find((row) => row.id === id)

const without = (save, ...ids) => edited(save, (copy) => {
  copy.bodies = copy.bodies.filter((row) => !ids.includes(row.id))
})

// The fake answers the query of the bodies of the known systems and records everything it is sent. `failing` names a fragment of SQL that makes it throw.
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

      throw new Error(`the fake save does not answer ${sql}`)
    },
  }
}

// ---- The suite -------------------------------------------------------------------------------------------------------

const suite = (m) => {
  const checks = []
  const check = (group, name, run) => checks.push({ group, name, run })
  const { tags, notes } = m

  // The bodies of an open save as the page hands them to the tags: the bodies the tags link to and those of the system picked, with the campaign and branch the save is open on.
  const open = async (save, where = scope(), { bodyIds = save.bodies.map((row) => row.id), systemId = null, branches = TREE, failing = [] } = {}) => {
    const database = fakeSave(save, { failing })
    const bodies = await tags.loadBodies(database, { GameID: 1, RaceID: where.RaceID, bodyIds, systemId })

    return { objects: { body: bodies }, GameID: 1, RaceID: where.RaceID, campaignId: where.campaignId, branchId: where.branchId, branches, database }
  }

  const aim = (context, id) => ({ type: 'body', row: context.objects.body.get(id) })

  const put = (w, where, context, id, tag = 'Colony site', extra = {}) => saveNow(tags, w.repo, where, { tag, target: aim(context, id), context, ...extra })

  const made = async (w, where, context, id, tag = 'Colony site', extra = {}) => {
    const outcome = await put(w, where, context, id, tag, extra)

    assert.equal(outcome.ok, true, outcome.message)

    return outcome.record
  }

  const list = (w, where = scope(), context = null) => tags.readTags(w.repo, where, context).entries

  const entryOf = (entries, id) => entries.find((entry) => entry.target.id === id)

  const texts = (entries) => entries.map((entry) => `${entry.target.id}:${entry.tag}`).sort()

  // ---- moon ---------------------------------------------------------------------------------------------------------

  check('moon', 'tagging a moon tags that moon only: its planet and its system carry no tag, whatever order the two are tagged in', async () => {
    const w = world(m)
    const context = await open(SAVE())

    await made(w, scope(), context, LUNA, 'Base')

    let entries = list(w, scope(), context)

    assert.deepEqual(texts(entries), ['102:Base'])
    assert.equal(entries[0].kind, 'Moon')
    assert.equal(entryOf(entries, EARTH), undefined)
    assert.deepEqual(Object.keys(tags.tagsBySystem(entries)), ['1'])
    assert.equal(tags.tagsBySystem(entries)['1'].entries.length, 1)

    await made(w, scope(), context, EARTH, 'Home')
    entries = list(w, scope(), context)
    assert.deepEqual(texts(entries), ['100:Home', '102:Base'])
    assert.equal(entryOf(entries, LUNA).tag, 'Base')
    assert.equal(entryOf(entries, MARS), undefined)
  })

  check('moon', 'a planet, a moon, an asteroid and a comet each take a tag and name their kind, and only the campaign\'s scenario file is written', async () => {
    const w = world(m)
    const context = await open(SAVE())

    for (const id of [EARTH, LUNA, CERES, HALLEY]) {
      await made(w, scope(), context, id, `Tag ${id}`)
    }

    const kinds = Object.fromEntries(list(w, scope(), context).map((entry) => [entry.target.id, entry.kind]))

    assert.deepEqual(kinds, { 100: 'Planet', 102: 'Moon', 103: 'Asteroid', 104: 'Comet' })
    assert.deepEqual([...w.inst.files.keys()], ['campaign-c1'])
  })

  // ---- known --------------------------------------------------------------------------------------------------------

  check('known', 'a body of a system the race does not know is not read and is refused, and the picker offers the bodies of the system picked with their class', async () => {
    const w = world(m)
    const save = SAVE()
    const context = await open(save, scope(), { systemId: 1 })

    assert.equal(context.objects.body.has(HIDDEN), false)
    assert.equal((await tags.loadBodies(fakeSave(save), { GameID: 1, RaceID: 7, systemId: 3 })).size, 0)

    const refused = await saveNow(tags, w.repo, scope(), { tag: 'Mine', target: { type: 'body', row: { ...aim(context, EARTH).row, id: HIDDEN, systemId: 3 } }, context })

    assert.equal(refused.ok, false)
    assert.equal(list(w).length, 0)

    const sol = tags.tagChoices(context.objects.body, 1)

    assert.deepEqual(sol.map((choice) => choice.name), ['Ceres', 'Earth', 'Halley', 'Luna', 'Mars'])
    assert.deepEqual(sol.map((choice) => choice.text), ['Ceres · Asteroid', 'Earth · Planet', 'Halley · Comet', 'Luna · Moon', 'Mars · Planet'])
    assert.deepEqual(tags.tagChoices(context.objects.body, 2).map((choice) => choice.name), ['Proxima b'])
    assert.equal(tags.tagChoices(context.objects.body, 3).length, 0)

    const alpha = await open(save, scope(), { bodyIds: [], systemId: 2 })

    assert.deepEqual(tags.tagChoices(alpha.objects.body, 2).map((choice) => choice.name), ['Proxima b'])
    assert.equal(tags.tagChoices(alpha.objects.body, 1).length, 0)
  })

  // ---- edit ---------------------------------------------------------------------------------------------------------

  check('edit', 'a tag is made, changed and cleared, and a body has one tag: tagging it again changes its tag', async () => {
    const w = world(m)
    const context = await open(SAVE())
    const record = await made(w, scope(), context, EARTH, 'Colony site')

    assert.equal(list(w, scope(), context).length, 1)

    const retagged = await saveNow(tags, w.repo, scope(), { entry: list(w, scope(), context)[0], tag: 'Mining', context })

    assert.equal(retagged.ok, true, retagged.message)
    assert.equal(retagged.record.uuid, record.uuid)
    assert.equal(retagged.record.revision, record.revision + 1)
    assert.deepEqual(texts(list(w, scope(), context)), ['100:Mining'])

    const again = await made(w, scope(), context, EARTH, 'Survey')

    assert.equal(again.uuid, record.uuid)
    assert.deepEqual(texts(list(w, scope(), context)), ['100:Survey'])

    const cleared = await tags.clearTag(w.repo, scope(), list(w, scope(), context)[0])

    assert.equal(cleared.ok, true, cleared.message)
    assert.equal(list(w, scope(), context).length, 0)
    assert.equal(list(world(m, w.inst), scope(), context).length, 0)
  })

  check('edit', 'the same text changes nothing: no revision is made', async () => {
    const w = world(m)
    const context = await open(SAVE())
    const record = await made(w, scope(), context, EARTH, 'Colony site')
    const outcome = await put(w, scope(), context, EARTH, '  Colony   site ')

    assert.equal(outcome.ok, true)
    assert.equal(outcome.unchanged, true)
    assert.equal(outcome.record, null)
    assert.equal(list(w, scope(), context)[0].revision, record.revision)
  })

  check('edit', 'a tag is kept with its ends trimmed and its spaces collapsed, and a tag of the longest length is valid', async () => {
    const w = world(m)
    const context = await open(SAVE())

    await made(w, scope(), context, EARTH, '  Long \t  haul  ')
    assert.equal(list(w, scope(), context)[0].tag, 'Long haul')
    assert.equal(tags.tagTextOf('  a   b '), 'a b')
    await made(w, scope(), context, MARS, 'x'.repeat(tags.TAG_LENGTH))
    assert.equal(list(w, scope(), context).length, 2)
  })

  check('edit', 'an empty, blank, too long or not text tag is refused and nothing is written', async () => {
    const w = world(m)
    const context = await open(SAVE())

    for (const bad of ['', '   ', 'x'.repeat(tags.TAG_LENGTH + 1), 7, null]) {
      const outcome = await put(w, scope(), context, EARTH, bad)

      assert.equal(outcome.ok, false, String(bad))
      assert.equal(outcome.code, 'invalid-tag', String(bad))
    }

    assert.equal(list(w).length, 0)
    assert.equal(w.inst.files.size, 0)
    assert.deepEqual(tags.problemsOf({ tag: 'ok', target: { type: 'body', id: 1, name: 'A', systemId: 1, systemName: 'S', origin: { campaignId: 'c', branchId: 'b' } }, extra: 1 }), ['extra is not a field of a tag'])
  })

  check('edit', 'an edit or a clear made over a revision that is not the one stored is refused and nothing is changed', async () => {
    const w = world(m)
    const context = await open(SAVE())

    await made(w, scope(), context, EARTH, 'One')

    const old = list(w, scope(), context)[0]

    await saveNow(tags, w.repo, scope(), { entry: old, tag: 'Two', context })

    const changed = await saveNow(tags, w.repo, scope(), { entry: old, tag: 'Three', context })

    assert.equal(changed.ok, false)
    assert.equal(changed.code, 'revision-conflict')
    assert.equal(changed.stored.tag, 'Two')

    const cleared = await tags.clearTag(w.repo, scope(), old)

    assert.equal(cleared.ok, false)
    assert.equal(cleared.code, 'revision-conflict')
    assert.deepEqual(texts(list(w, scope(), context)), ['100:Two'])
  })

  check('edit', 'a tag is made over what the body had when it was picked: a tag changed, made or cleared elsewhere since is a conflict, nothing is written, and a missing expectation is refused', async () => {
    const context = await open(SAVE())
    const where = scope()
    const row = context.objects.body.get(EARTH)
    const stored = (w) => list(w, where, context).map((entry) => `${entry.target.id}:${entry.tag}@${entry.revision}`)
    const form = (w) => tags.expectedOf(tags.readTags(w.repo, where, context).entries, row)

    // The body had a tag at revision 1 and it was changed to revision 2 elsewhere.
    const tagged = world(m)

    await made(tagged, where, context, EARTH, 'One')

    const opened = form(tagged)

    assert.equal(opened.revision, 1)
    await tags.saveTag(tagged.repo, where, { entry: list(tagged, where, context)[0], tag: 'Elsewhere', context })

    const changed = await tags.saveTag(tagged.repo, where, { tag: 'Draft', target: aim(context, EARTH), expected: opened, context })

    assert.equal(changed.ok, false)
    assert.equal(changed.code, 'revision-conflict')
    assert.deepEqual(stored(tagged), ['100:Elsewhere@2'])

    // The body had none and a tag was made elsewhere.
    const untagged = world(m)
    const none = form(untagged)

    assert.deepEqual(none, { uuid: null, revision: null })
    await made(untagged, where, context, EARTH, 'Elsewhere')

    const made_ = await tags.saveTag(untagged.repo, where, { tag: 'Draft', target: aim(context, EARTH), expected: none, context })

    assert.equal(made_.code, 'revision-conflict')
    assert.deepEqual(stored(untagged), ['100:Elsewhere@1'])

    // The body had a tag and it was cleared elsewhere: nothing is made in its place.
    const gone = world(m)

    await made(gone, where, context, EARTH, 'One')

    const before = form(gone)

    assert.equal((await tags.clearTag(gone.repo, where, list(gone, where, context)[0])).ok, true)

    const cleared = await tags.saveTag(gone.repo, where, { tag: 'Draft', target: aim(context, EARTH), expected: before, context })

    assert.equal(cleared.code, 'revision-conflict')
    assert.deepEqual(stored(gone), [])

    // The expectation still held is written over, and none at all is refused.
    const held = world(m)

    await made(held, where, context, EARTH, 'One')

    const fine = await tags.saveTag(held.repo, where, { tag: 'Two', target: aim(context, EARTH), expected: form(held), context })

    assert.equal(fine.ok, true)
    assert.deepEqual(stored(held), ['100:Two@2'])

    const missing = await tags.saveTag(held.repo, where, { tag: 'Three', target: aim(context, EARTH), context })

    assert.equal(missing.ok, false)
    assert.equal(missing.code, 'invalid-tag')
    assert.deepEqual(stored(held), ['100:Two@2'])
  })

  // The store client's compare-and-swap runs a write again over what is stored when another window wrote between its read and its swap. The expectation of a tag is checked inside that write, so it is checked again then.
  check('edit', 'a tag written while another window writes between its read and its swap is made over what the body had when it was picked: a tag made, changed or cleared there is a conflict, one tag is left, and a write to another body goes through', async () => {
    const context = await open(SAVE())
    const where = scope()
    const stored = (win) => tags.readTags(win.other, where, context).entries.map((entry) => `${entry.tag}@${entry.revision}`)
    const expectedOf = (win, id) => tags.expectedOf(tags.readTags(win.first.repo, where, context).entries, context.objects.body.get(id))
    const ask = (win, id, expected, text) => tags.saveTag(win.first.repo, where, { tag: text, target: aim(context, id), expected, context })

    // The body had none and another window made a tag on it.
    const made_ = interleaved(m, rivalCreate(m, where, context, LUNA, 'Second'))
    const none = expectedOf(made_, LUNA)

    made_.arm()

    const lostMade = await ask(made_, LUNA, none, 'First')

    assert.equal(lostMade.ok, false)
    assert.equal(lostMade.code, 'revision-conflict')
    assert.equal(made_.swaps(), 1, 'the first swap failed and the write was not made again')
    assert.deepEqual(stored(made_), ['Second@1'])

    // The body had a tag and another window changed it.
    const changed = interleaved(m, rivalChange(m, where, context, 'Elsewhere'))

    assert.equal((await ask(changed, LUNA, expectedOf(changed, LUNA), 'One')).ok, true)

    const held = expectedOf(changed, LUNA)

    changed.arm()

    const lostChanged = await ask(changed, LUNA, held, 'Mine')

    assert.equal(lostChanged.code, 'revision-conflict')
    assert.deepEqual(stored(changed), ['Elsewhere@2'])

    // The body had a tag and another window cleared it: nothing is made in its place.
    const cleared = interleaved(m, rivalClear(m, where, context))

    assert.equal((await ask(cleared, LUNA, expectedOf(cleared, LUNA), 'One')).ok, true)

    const before = expectedOf(cleared, LUNA)

    cleared.arm()

    const lostCleared = await ask(cleared, LUNA, before, 'Mine')

    assert.equal(lostCleared.code, 'revision-conflict')
    assert.deepEqual(stored(cleared), [])

    // Another window's tag on another body changes nothing of this one: the write is made again over what is stored and goes through.
    const apart = interleaved(m, rivalCreate(m, where, context, MARS, 'Other'))
    const untouched = expectedOf(apart, LUNA)

    apart.arm()

    const through = await ask(apart, LUNA, untouched, 'First')

    assert.equal(through.ok, true, through.message)
    assert.equal(apart.swaps(), 2, 'the first swap failed and the write was made again')
    assert.deepEqual(stored(apart), ['First@1', 'Other@1'])

    // No other window writes: one swap, one tag.
    const alone = interleaved(m, () => {})

    alone.arm()
    assert.equal((await ask(alone, LUNA, expectedOf(alone, LUNA), 'First')).ok, true)
    assert.equal(alone.swaps(), 1)
    assert.deepEqual(stored(alone), ['First@1'])
  })

  check('edit', 'a stale tag is changed without a new link: it keeps its body, its name and its stale state', async () => {
    const w = world(m)

    await made(w, scope(), await open(SAVE()), LUNA, 'Base')

    const gone = await open(without(SAVE(), LUNA))
    const [stale] = list(w, scope(), gone)

    assert.equal(stale.stale, true)

    const outcome = await saveNow(tags, w.repo, scope(), { entry: stale, tag: 'Old base', context: gone })

    assert.equal(outcome.ok, true, outcome.message)

    const [after] = list(w, scope(), gone)

    assert.equal(after.uuid, stale.uuid)
    assert.equal(after.tag, 'Old base')
    assert.equal(after.stale, true)
    assert.equal(after.link.status, 'missing')
    assert.equal(after.target.id, LUNA)
    assert.equal(after.target.name, 'Luna')
    assert.equal(after.target.systemName, 'Sol')

    const given = await open(edited(SAVE(), (copy) => { Object.assign(found(copy.bodies, LUNA), { name: 'Phobos', bodyClass: 3, planet: 9, systemId: 2 }) }))
    const [changed] = list(w, scope(), given)

    assert.equal(changed.link.status, 'changed')
    assert.equal((await saveNow(tags, w.repo, scope(), { entry: changed, tag: 'Older base', context: given })).ok, true)

    const [kept] = list(w, scope(), given)

    assert.equal(kept.tag, 'Older base')
    assert.equal(kept.stale, true)
    assert.equal(kept.target.name, 'Luna')
    assert.equal(kept.target.systemId, 1)
    assert.equal(kept.target.systemName, 'Sol')
  })

  // ---- stale --------------------------------------------------------------------------------------------------------

  check('stale', 'a body that is gone leaves its tag listed, stale, with the name and the system it had, in the system it was last known in', async () => {
    const w = world(m)

    await made(w, scope(), await open(SAVE()), LUNA, 'Base')

    const entries = list(w, scope(), await open(without(SAVE(), LUNA)))

    assert.equal(entries.length, 1)
    assert.equal(entries[0].stale, true)
    assert.equal(entries[0].link.status, 'missing')
    assert.equal(entries[0].target.name, 'Luna')
    assert.equal(entries[0].place.systemName, 'Sol')
    assert.equal(entries[0].place.lastKnown, true)
    assert.equal(tags.tagsBySystem(entries)['1'].stale, true)
  })

  check('stale', 'an ID that another body holds now reads changed and stale, and tagging that body makes a tag of its own: the stale one is never moved to it', async () => {
    const w = world(m)

    await made(w, scope(), await open(SAVE()), LUNA, 'Base')

    const given = edited(SAVE(), (copy) => {
      Object.assign(found(copy.bodies, LUNA), { name: 'Phobos', bodyClass: 3, planet: 9 })
    })
    const context = await open(given)
    const [before] = list(w, scope(), context)

    assert.equal(before.link.status, 'changed')
    assert.equal(before.stale, true)
    assert.equal(before.target.name, 'Luna')

    const fresh = await made(w, scope(), context, LUNA, 'Rock')
    const entries = list(w, scope(), context)

    assert.notEqual(fresh.uuid, before.uuid)
    assert.equal(entries.length, 2)
    assert.equal(entries.find((entry) => entry.uuid === before.uuid).tag, 'Base')
    assert.equal(entries.find((entry) => entry.uuid === before.uuid).stale, true)
    assert.equal(entries.find((entry) => entry.uuid === fresh.uuid).stale, false)
    assert.equal(entries.find((entry) => entry.uuid === fresh.uuid).target.name, 'Phobos')
  })

  check('stale', 'a renamed body keeps its tag linked and shows the new name beside the one kept, and a renamed system leaves an unnamed body to follow it', async () => {
    const w = world(m)

    await made(w, scope(), await open(SAVE()), LUNA, 'Base')

    const renamed = edited(SAVE(), (copy) => {
      found(copy.bodies, LUNA).name = 'Selene'
      found(copy.systems, 1).name = 'Sol Prime'
    })
    const [entry] = list(w, scope(), await open(renamed))

    assert.equal(entry.link.status, 'linked')
    assert.equal(entry.link.nowNamed, 'Selene')
    assert.equal(entry.target.name, 'Luna')
    assert.equal(entry.stale, false)
    assert.equal(entry.place.systemName, 'Sol Prime')
    assert.equal(entry.place.lastKnown, false)
    assert.equal(tags.tagsBySystem([entry])['1'].stale, false)
  })

  check('stale', 'no fingerprint holds a name, so a rename never changes it', async () => {
    const context = await open(SAVE())

    for (const row of context.objects.body.values()) {
      assert.equal(tags.tagAdapter.fingerprint('body', row), tags.tagAdapter.fingerprint('body', { ...row, name: 'Another name' }))
      assert.equal(tags.tagAdapter.fingerprint('body', row).includes(row.name), false)
    }
  })

  check('stale', 'a tag whose body is gone is never relinked to another body with the same name or the same place', async () => {
    const w = world(m)

    await made(w, scope(), await open(SAVE()), LUNA, 'Base')

    const twin = edited(without(SAVE(), LUNA), (copy) => {
      copy.bodies.push(body(777, 'Luna', 1, 3, 1, 2, 6))
    })
    const context = await open(twin)

    assert.equal(context.objects.body.get(777).name, 'Luna')

    const [entry] = list(w, scope(), context)

    assert.equal(entry.link.status, 'missing')
    assert.equal(entry.stale, true)
    assert.equal(entry.target.id, LUNA)
    assert.equal(list(w, scope(), context).length, 1)
  })

  check('stale', 'a body that is not read, or whose read is not known, is not checked: never gone, never stale', async () => {
    const w = world(m)

    await made(w, scope(), await open(SAVE()), LUNA, 'Base')

    const unread = list(w)

    assert.equal(unread.length, 1)
    assert.equal(unread[0].stale, false)
    assert.equal(unread[0].link.status, 'unknown')
    assert.equal(unread[0].place.systemName, 'Sol')
    assert.equal(unread[0].place.lastKnown, false)
    await assert.rejects(() => open(SAVE(), scope(), { failing: ['FCT_SystemBody'] }), /FCT_SystemBody/)
  })

  check('stale', 'a stale tag is read the same after a restart of the app', async () => {
    const inst = memory()
    const w = world(m, inst)

    await made(w, scope(), await open(SAVE()), LUNA, 'Base')

    const gone = await open(without(SAVE(), LUNA))
    const before = list(w, scope(), gone)
    const after = list(world(m, inst), scope(), gone)

    assert.deepEqual(after, before)
    assert.equal(after[0].stale, true)
  })

  // ---- rewind -------------------------------------------------------------------------------------------------------

  check('rewind', 'a save from before the system was found reads the tag as gone, ahead of the save, with the time the system was found, and a later save matches it again', async () => {
    const w = world(m)

    await made(w, scope(), await open(SAVE()), PROXIMA, 'Target')

    const earlier = scope('b1', 7, 'c1', 1500)
    const before = list(w, earlier, await open(edited(SAVE(), (copy) => { copy.systems = copy.systems.filter((one) => one.id !== 2) }), earlier))

    assert.equal(before.length, 1)
    assert.equal(before[0].link.status, 'missing')
    assert.equal(before[0].stale, true)
    assert.equal(before[0].ahead, true)
    assert.equal(before[0].discoveredAt, 2000)
    assert.equal(before[0].madeAt, 100000)

    const later = list(w, scope(), await open(SAVE()))

    assert.equal(later[0].link.status, 'linked')
    assert.equal(later[0].stale, false)
    assert.equal(later[0].ahead, false)
    assert.equal(later[0].discoveredAt, 2000)
  })

  check('rewind', 'a save in which the system was found at another time holds another body under the ID: the tag reads changed and ahead, never linked', async () => {
    const w = world(m)

    await made(w, scope(), await open(SAVE()), PROXIMA, 'Target')

    const earlier = scope('b1', 7, 'c1', 1500)
    const regenerated = edited(SAVE(), (copy) => {
      found(copy.systems, 2).discovered = 1800
    })
    const [entry] = list(w, earlier, await open(regenerated, earlier))

    assert.equal(entry.link.status, 'changed')
    assert.equal(entry.stale, true)
    assert.equal(entry.ahead, true)
    assert.equal(entry.discoveredAt, 2000)
  })

  // ---- isolation ----------------------------------------------------------------------------------------------------

  check('isolation', 'another race lists none of the tags of this one, and a tag is kept for the race it was made for', async () => {
    const w = world(m)

    await made(w, scope(), await open(SAVE()), EARTH, 'Mine')

    const other = scope('b1', 8)

    assert.equal(list(w, other, await open(SAVE(), other)).length, 0)
    await made(w, other, await open(SAVE(), other), EARTH, 'Theirs')
    assert.deepEqual(texts(list(w, scope(), await open(SAVE()))), ['100:Mine'])
    assert.deepEqual(texts(list(w, other, await open(SAVE(), other))), ['100:Theirs'])
  })

  check('isolation', 'a tag is kept for its branch: another branch of the campaign lists none of it, and clearing it on one leaves the other', async () => {
    const w = world(m)
    const [b1, b2] = [scope('b1'), scope('b2')]

    await made(w, b1, await open(SAVE(), b1), EARTH, 'On b1')
    assert.equal(list(w, b2, await open(SAVE(), b2)).length, 0)
    await made(w, b2, await open(SAVE(), b2), EARTH, 'On b2')
    assert.deepEqual(texts(list(w, b1, await open(SAVE(), b1))), ['100:On b1'])
    assert.deepEqual(texts(list(w, b2, await open(SAVE(), b2))), ['100:On b2'])
    assert.equal((await tags.clearTag(w.repo, b2, list(w, b2)[0])).ok, true)
    assert.deepEqual(texts(list(w, b1, await open(SAVE(), b1))), ['100:On b1'])
  })

  check('isolation', 'another campaign lists none of the tags of this one, and the tags live in the campaign\'s own scenario file', async () => {
    const w = world(m)
    const other = scope('b1', 7, 'c2')

    await made(w, scope(), await open(SAVE()), EARTH, 'Mine')
    assert.equal(list(w, other, await open(SAVE(), other)).length, 0)
    await made(w, other, await open(SAVE(), other), EARTH, 'Other campaign')
    assert.deepEqual([...w.inst.files.keys()].sort(), ['campaign-c1', 'campaign-c2'])
    assert.deepEqual(texts(list(w, scope(), await open(SAVE()))), ['100:Mine'])
  })

  check('isolation', 'the tags and the notes are kinds of their own: a note is not a tag and a tag is not a note', async () => {
    const w = world(m)
    const context = await open(SAVE())

    await made(w, scope(), context, EARTH, 'Tag')

    const note = await notes.saveNote(w.repo, scope(), { title: 'A note', status: 'planned', next: 'Do it', target: { type: 'body', row: context.objects.body.get(MARS) }, context })

    assert.equal(note.ok, true, note.message)
    assert.deepEqual(texts(list(w, scope(), context)), ['100:Tag'])
    assert.equal(notes.readNotes(w.repo, scope(), context).entries.length, 1)
    assert.equal(notes.readNotes(w.repo, scope(), context).entries[0].title, 'A note')
  })

  check('isolation', 'the tags survive a restart of the app, each in the scope it was made in', async () => {
    const inst = memory()
    const w = world(m, inst)

    await made(w, scope(), await open(SAVE()), EARTH, 'Mine')

    const restarted = world(m, inst)

    assert.deepEqual(texts(list(restarted, scope(), await open(SAVE()))), ['100:Mine'])
    assert.equal(list(restarted, scope('b2')).length, 0)
    assert.equal(list(restarted, scope('b1', 8)).length, 0)
  })

  // ---- filter -------------------------------------------------------------------------------------------------------

  const FILTERED = async () => {
    const w = world(m)
    const context = await open(SAVE())

    await made(w, scope(), context, EARTH, 'all')
    await made(w, scope(), context, MARS, 'stale')
    await made(w, scope(), context, LUNA, 'Colony')
    await made(w, scope(), context, CERES, 'Colony')
    await made(w, scope(), context, PROXIMA, 'Colony')

    return { w, entries: list(w, scope(), await open(without(SAVE(), LUNA, PROXIMA))) }
  }

  check('filter', 'the tag filter finds a tag by its text, and the words all and stale are ordinary tags a filter value never mistakes for a command', async () => {
    const { entries } = await FILTERED()
    const options = tags.tagOptions(entries)

    assert.deepEqual(options.map((option) => option.value).sort(), ['all', 'stale', 'tag:Colony', 'tag:all', 'tag:stale'].sort())
    assert.equal(options.find((option) => option.value === 'all').count, 5)
    assert.equal(options.find((option) => option.value === 'tag:Colony').count, 3)
    assert.equal(options.find((option) => option.value === 'tag:all').text, 'all')
    assert.deepEqual(texts(tags.filterByTag(entries, tags.ALL_TAGS)), texts(entries))
    assert.deepEqual(texts(tags.filterByTag(entries, tags.tagValue('all'))), ['100:all'])
    assert.deepEqual(texts(tags.filterByTag(entries, tags.tagValue('stale'))), ['101:stale'])
    assert.deepEqual(texts(tags.filterByTag(entries, tags.tagValue('Colony'))), ['102:Colony', '103:Colony', '200:Colony'])
    assert.deepEqual(tags.tagSuggestions(entries), ['all', 'Colony', 'stale'])
  })

  check('filter', 'a stale tag is listed under its own text and under Stale tags, and the Stale choice is offered only while one exists', async () => {
    const { w, entries } = await FILTERED()

    assert.deepEqual(texts(tags.filterByTag(entries, tags.STALE_TAGS)), ['102:Colony', '200:Colony'])
    assert.equal(tags.tagOptions(entries).find((option) => option.value === tags.STALE_TAGS).count, 2)
    assert.equal(tags.tagOptions(list(w, scope(), await open(SAVE()))).some((option) => option.value === tags.STALE_TAGS), false)
  })

  check('filter', 'the tags are grouped by system for the map, a stale one in the system it was last known in, and a system reads stale only when every tag there is', async () => {
    const { entries } = await FILTERED()
    const systems = tags.tagsBySystem(entries)

    assert.deepEqual(Object.keys(systems).sort(), ['1', '2'])
    assert.equal(systems['1'].entries.length, 4)
    assert.equal(systems['1'].stale, false)
    assert.equal(systems['2'].entries.length, 1)
    assert.equal(systems['2'].stale, true)
    const staleSystems = tags.tagsBySystem(tags.filterByTag(entries, tags.STALE_TAGS))

    assert.deepEqual(Object.keys(staleSystems).sort(), ['1', '2'])
    assert.equal(Object.values(staleSystems).every((one) => one.stale), true)
    assert.deepEqual(tags.tagsBySystem([]), {})
  })

  // ---- scope --------------------------------------------------------------------------------------------------------

  check('scope', 'a tag is made only against the bodies of the race, campaign and branch it is kept for', async () => {
    const w = world(m)
    const here = await open(SAVE())

    for (const [name, other] of [['race', scope('b1', 8)], ['campaign', scope('b1', 7, 'c2')], ['branch', scope('b2')]]) {
      const context = await open(SAVE(), other)
      const outcome = await put(w, scope(), context, EARTH, 'Mine', { target: aim(context, EARTH) })

      assert.equal(outcome.ok, false, name)
    }

    assert.equal(list(w, scope(), here).length, 0)
    assert.equal(w.inst.files.size, 0)
  })

  check('scope', 'a tag is made only for a body that is there as it was picked: not one the open save lacks, not one that changed since it was picked, not another kind of object', async () => {
    const w = world(m)
    const context = await open(SAVE())
    const earth = aim(context, EARTH).row

    for (const row of [{ ...earth, id: 4242 }, { ...earth, bodyClass: 2 }, { ...earth, planetNumber: 99 }]) {
      assert.equal((await saveNow(tags, w.repo, scope(), { tag: 'Mine', target: { type: 'body', row }, context })).ok, false, JSON.stringify(row))
    }

    const colony = await saveNow(tags, w.repo, scope(), { tag: 'Mine', target: { type: 'colony', row: earth }, context })

    assert.equal(colony.ok, false)
    assert.equal(colony.code, 'invalid-tag')
    assert.equal((await saveNow(tags, w.repo, scope(), { tag: 'Mine', target: { type: 'body', row: earth } })).ok, false)
    assert.equal(list(w).length, 0)
  })

  check('scope', 'the link keeps the name, the system and the branch the tag was made on', async () => {
    const w = world(m)
    const b2 = scope('b2')
    const context = await open(SAVE(), b2)

    await made(w, b2, context, LUNA, 'Base')

    const [entry] = list(w, b2, context)

    assert.deepEqual(entry.target.origin, { campaignId: 'c1', branchId: 'b2' })
    assert.equal(entry.target.name, 'Luna')
    assert.equal(entry.target.systemId, 1)
    assert.equal(entry.target.systemName, 'Sol')
    assert.equal(entry.links[0].type, 'body')
    assert.equal(entry.links[0].id, LUNA)
    assert.equal(entry.links[0].fingerprint, tags.WORLD_TARGETS.body.fingerprint(aim(context, LUNA).row))
  })

  // ---- reads --------------------------------------------------------------------------------------------------------

  check('reads', 'every query is a select, and keeping, changing and clearing a tag sends nothing to the save', async () => {
    const w = world(m)
    const context = await open(SAVE())
    const sent = () => context.database.sent.length

    assert.ok(sent() > 0)
    context.database.sent.forEach(({ sql }) => assert.match(sql, /^select /))

    const before = sent()

    await made(w, scope(), context, EARTH, 'Mine')
    await saveNow(tags, w.repo, scope(), { entry: list(w, scope(), context)[0], tag: 'Yours', context })
    await put(w, scope(), context, EARTH, 'Again')
    await tags.clearTag(w.repo, scope(), list(w, scope(), context)[0])
    assert.equal(sent(), before)
    context.database.sent.forEach(({ sql }) => assert.match(sql, /^select /))
  })

  check('reads', 'the bodies are read by ID in batches and by system, never all of them', async () => {
    const many = { systems: [system(1, 'Sol', 500)], bodies: Array.from({ length: 1000 }, (_unused, index) => body(1000 + index, `B${index}`, 1)) }
    const database = fakeSave(many)
    const bodies = await tags.loadBodies(database, { GameID: 1, RaceID: 7, bodyIds: many.bodies.map((row) => row.id) })

    assert.equal(bodies.size, 1000)
    assert.equal(database.sent.length, Math.ceil(1000 / notes.BODIES_PER_READ))

    const none = fakeSave(SAVE())

    assert.equal((await tags.loadBodies(none, { GameID: 1, RaceID: 7 })).size, 0)
    assert.equal(none.sent.length, 0)
    assert.equal((await tags.loadBodies(none, { GameID: 1, RaceID: 7, systemId: 1 })).size, 5)
    assert.equal(none.sent.length, 1)
  })

  // ---- backup -------------------------------------------------------------------------------------------------------

  const annotated = (inst, ids = 0) => {
    const w = world(m, inst)
    const repository = m.records.createRepository({ storage: inst.storage, adapters: w.registry, newId: () => uuid(++ids), now: () => 1000 + ids })

    return { repository, adapter: m.backup.annotationsOf(repository, inst.storage), registry: w.registry }
  }

  check('backup', 'tags round-trip through the backup\'s annotation adapter with their text, link and uuid', async () => {
    const source = annotated(memory(), 0)
    const context = await open(SAVE())

    await saveNow(tags, source.repository, scope(), { tag: 'Base', target: aim(context, LUNA), context })
    await saveNow(tags, source.repository, scope(), { tag: 'Home', target: aim(context, EARTH), context })

    const bundle = source.adapter.export(scope())

    assert.equal(bundle.records.length, 2)

    const target = annotated(memory(), 1000)
    const place = { campaignId: 'c1', RaceID: 7, branch: 'b1' }
    const preview = target.adapter.preview(bundle, place, { restore: true })

    assert.equal(preview.items.every((item) => item.status === 'import'), true, JSON.stringify(preview).slice(0, 300))
    assert.equal(target.adapter.import(bundle, place, { preview, restore: true }).imported.length, 2)

    const entries = tags.readTags(target.repository, scope(), context).entries

    assert.deepEqual(texts(entries), ['100:Home', '102:Base'])
    assert.equal(entries.every((entry) => entry.link.status === 'linked'), true)
    assert.deepEqual(entries.map((entry) => entry.uuid).sort(), bundle.records.map((record) => record.uuid).sort())
  })

  check('backup', 'a kind the installation has no adapter for is refused, so a backup needs the tags\' adapter registered', async () => {
    const source = annotated(memory(), 0)

    await saveNow(tags, source.repository, scope(), { tag: 'Base', target: aim(await open(SAVE()), LUNA), context: await open(SAVE()) })

    const bundle = source.adapter.export(scope())
    const bare = memory()
    const registry = m.records.createAdapterRegistry()
    const repository = m.records.createRepository({ storage: bare.storage, adapters: registry, now: () => 1 })
    const adapter = m.backup.annotationsOf(repository, bare.storage)
    const preview = adapter.preview(bundle, { campaignId: 'c1', RaceID: 7, branch: 'b1' }, { restore: true })

    assert.equal(bundle.records.length, 1)
    assert.equal(preview.items.every((item) => item.status === 'rejected'), true)
  })

  check('backup', 'the adapter is for bodies only: no other kind of object has a fingerprint, and a tag that names another kind is not valid', async () => {
    assert.equal(tags.tagAdapter.kind, 'world.tag')
    assert.throws(() => tags.tagAdapter.fingerprint('colony', { id: 1 }), /not a kind of object a tag is about/)
    assert.equal(typeof tags.tagAdapter.fingerprint('body', aim(await open(SAVE()), EARTH).row), 'string')

    const target = { type: 'body', id: 1, name: 'A', systemId: 1, systemName: 'S', origin: { campaignId: 'c', branchId: 'b' } }

    assert.deepEqual(tags.problemsOf({ tag: 'ok', target }), [])
    assert.equal(tags.problemsOf({ tag: 'ok', target: { ...target, type: 'colony' } }).length, 1)
    assert.equal(tags.problemsOf({ tag: 'ok', target: { ...target, type: 'fleet' } }).length, 1)
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

  const GAME = 140
  const RACE = 784
  const KNOWN = 'inner join FCT_RaceSysSurvey on FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID and FCT_RaceSysSurvey.RaceID = :RaceID and FCT_RaceSysSurvey.GameID = :GameID where FCT_SystemBody.GameID = :GameID and FCT_SystemBody.BodyClass in (1, 2, 3, 5)'
  const boscoFiles = () => (fs.existsSync(BOSCO) ? fs.readdirSync(BOSCO).filter((name) => name.endsWith('.db')).sort() : [])

  // The saves of the line, oldest game time first, each opened read only.
  const lineOfSaves = async () => {
    const saves = boscoFiles().map((name) => openSave(path.join(BOSCO, name)))

    for (const save of saves) {
      const [game] = await save.run('select GameTime from FCT_Game where GameID = :GameID', { GameID: GAME })

      save.time = game ? game.GameTime : null
    }

    return saves.filter((save) => save.time !== null).sort((a, b) => a.time - b.time)
  }

  const contextOfSave = async (save, ids) => ({ objects: { body: await tags.loadBodies(save.database, { GameID: GAME, RaceID: RACE, bodyIds: ids }) }, GameID: GAME, RaceID: RACE, campaignId: 'c1', branchId: 'b1', branches: TREE })

  check('saves', 'on the owner\'s saves a body that was never surveyed is known and taggable, a body of an unknown system is not read and is refused, and a moon leaves its planet untagged', async () => {
    const files = boscoFiles()

    if (files.length < 2) {
      return { skipped: 'the boscodiogigia saves are not here' }
    }

    const saves = await lineOfSaves()
    const save = saves[saves.length - 1]
    const digest = () => crypto.createHash('sha256').update(fs.readFileSync(save.file)).digest('hex')
    const before = digest()

    try {
      const [plain] = await save.run(`select FCT_SystemBody.SystemBodyID as id from FCT_SystemBody ${KNOWN} and not exists (select 1 from FCT_SystemBodySurveys where FCT_SystemBodySurveys.GameID = :GameID and FCT_SystemBodySurveys.RaceID = :RaceID and FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID) limit 1`, { GameID: GAME, RaceID: RACE })
      const [hidden] = await save.run('select FCT_SystemBody.SystemBodyID as id from FCT_SystemBody where FCT_SystemBody.GameID = :GameID and FCT_SystemBody.BodyClass in (1, 2, 3, 5) and not exists (select 1 from FCT_RaceSysSurvey where FCT_RaceSysSurvey.GameID = :GameID and FCT_RaceSysSurvey.RaceID = :RaceID and FCT_RaceSysSurvey.SystemID = FCT_SystemBody.SystemID) limit 1', { GameID: GAME, RaceID: RACE })
      const [moon] = await save.run(`select FCT_SystemBody.SystemBodyID as id, planet.SystemBodyID as planetId from FCT_SystemBody inner join FCT_SystemBody as planet on planet.GameID = FCT_SystemBody.GameID and planet.SystemID = FCT_SystemBody.SystemID and planet.PlanetNumber = FCT_SystemBody.PlanetNumber and planet.BodyClass = 1 ${KNOWN.replace('FCT_SystemBody.BodyClass in (1, 2, 3, 5)', 'FCT_SystemBody.BodyClass = 2')} limit 1`, { GameID: GAME, RaceID: RACE })

      assert.ok(plain && hidden && moon, 'the line holds a body that was never surveyed, a body of an unknown system and a moon with its planet')

      const context = await contextOfSave(save, [plain.id, hidden.id, moon.id, moon.planetId])
      const w = world(m)
      const where = { campaignId: 'c1', RaceID: RACE, branchId: 'b1', gameTime: save.time }

      assert.equal(context.objects.body.has(plain.id), true)
      assert.equal(context.objects.body.has(hidden.id), false)
      assert.equal(context.objects.body.get(moon.id).bodyClass, 2)
      assert.equal(context.objects.body.get(moon.planetId).bodyClass, 1)
      assert.equal((await made(w, where, context, plain.id, 'Unsurveyed')).kind, 'world.tag')
      assert.equal((await made(w, where, context, moon.id, 'Moon only')).kind, 'world.tag')

      const refused = await saveNow(tags, w.repo, where, { tag: 'Nowhere', target: { type: 'body', row: { ...context.objects.body.get(plain.id), id: hidden.id } }, context })

      assert.equal(refused.ok, false)

      const entries = list(w, where, context)

      assert.deepEqual(entries.map((entry) => entry.target.id).sort((a, b) => a - b), [plain.id, moon.id].sort((a, b) => a - b))
      assert.equal(entryOf(entries, moon.planetId), undefined)
      assert.equal(entries.every((entry) => entry.link.status === 'linked' && !entry.stale && !entry.ahead), true)
      assert.ok(save.sent.length >= 1)
      save.sent.forEach((sql) => assert.match(sql, /^select /))
    } finally {
      saves.forEach((one) => one.close())
    }

    assert.equal(digest(), before)

    return 'an unsurveyed body and a moon tagged, a body of an unknown system refused'
  })

  check('saves', 'on the owner\'s saves a tag made in the latest save reads as gone and ahead in the earliest, shows the time its system was found, and is linked again in the latest', async () => {
    if (boscoFiles().length < 2) {
      return { skipped: 'the boscodiogigia saves are not here' }
    }

    const saves = await lineOfSaves()
    const [first, last] = [saves[0], saves[saves.length - 1]]

    try {
      assert.ok(first.time < last.time)

      const [late] = await last.run(`select FCT_SystemBody.SystemBodyID as id, FCT_RaceSysSurvey.DiscoveredTime as found from FCT_SystemBody ${KNOWN} and FCT_RaceSysSurvey.DiscoveredTime > ${first.time} order by FCT_SystemBody.SystemBodyID limit 1`, { GameID: GAME, RaceID: RACE })
      const [old] = await first.run(`select FCT_SystemBody.SystemBodyID as id from FCT_SystemBody ${KNOWN} order by FCT_SystemBody.SystemBodyID limit 1`, { GameID: GAME, RaceID: RACE })

      assert.ok(late && old, 'the latest save knows a system found after the earliest save, and the earliest save knows a body')

      const w = world(m)
      const written = { campaignId: 'c1', RaceID: RACE, branchId: 'b1', gameTime: last.time }
      const rewound = { ...written, gameTime: first.time }
      const context = await contextOfSave(last, [late.id, old.id])

      await made(w, written, context, late.id, 'Found later')
      await made(w, written, context, old.id, 'Found early')

      const back = await contextOfSave(first, [late.id, old.id])
      const entries = list(w, rewound, back)
      const lateEntry = entryOf(entries, late.id)
      const oldEntry = entryOf(entries, old.id)

      assert.equal(back.objects.body.has(late.id), false)
      assert.equal(lateEntry.stale, true)
      assert.equal(lateEntry.link.status, 'missing')
      assert.equal(lateEntry.ahead, true)
      assert.equal(lateEntry.discoveredAt, late.found)
      assert.ok(lateEntry.discoveredAt > first.time)
      assert.equal(oldEntry.stale, false)
      assert.equal(oldEntry.ahead, true)

      const now = list(w, written, context)

      assert.equal(now.every((entry) => entry.link.status === 'linked' && !entry.stale && !entry.ahead), true)

      return `a tag on a body of a system found at ${late.found} reads gone in the save at ${first.time}`
    } finally {
      saves.forEach((one) => one.close())
    }
  })

  return checks
}

// ---- The pages -------------------------------------------------------------------------------------------------------

const RACE_SHOWN = 7

// The save the pages' checks open: two systems of the map, each with bodies.
const MAP_SAVE = () => ({
  systems: [system(9, 'Alpha', 9000), system(80, 'Beta', 80000)],
  bodies: [body(900, 'Alpha I', 9, 1), body(901, 'Alpha II', 9, 2, 0, 1), body(800, 'Beta I', 80, 1), body(801, 'Beta II', 80, 2)],
})

const NO_FEATURES = { ruins: [], constructs: [], rifts: 0, wrecks: 0, protection: 0, military: 0, ships: 0, shipyards: 0, waypoints: 0, contacts: [] }
const MAP_SYSTEMS = [[9, 'Alpha'], [80, 'Beta'], [50, 'Sol'], [7, 'Dark']].map(([SystemID, Name], index) => ({ SystemID, Name, Xcor: index * 60, Ycor: 0, Bodies: 4, SurveyedBodies: 1, Planets: 3, Comets: 0, GroundSurveys: 0, Colonies: 0, Population: 0, PopulationReported: 1, Capital: 0, DangerRating: 0, NoAutoRoute: 0, Stars: 1, SpectralClass: 'G', SizeText: 'V', DiscoveredTime: 1000 * SystemID, X: index, Y: 0, Z: 0 }))

const once = (from, to) => (text) => patched('the page', text, from, to)

const pageSuite = async (m, { target = null, find = null, replace = null } = {}) => {
  const { tags } = m
  const mixinText = fs.readFileSync(mixinFile, 'utf8').replace(/\r\n/g, '\n')
  const sources = target === 'mixin' ? { 'mixins/world-tags': patched('mixins/world-tags.js', mixinText, unhashed(find), unhashed(replace)) } : {}
  const mutate = (name) => (target === name ? once(unhashed(find), unhashed(replace)) : null)
  const lazy = (load) => {
    let loaded = null

    return () => {
      loaded = loaded || load()

      return loaded
    }
  }
  const mixinOptions = lazy(() => loadPage('mixins/world-tags', { stubs: STUBS, sources }))
  const componentOptions = lazy(() => loadPage('components/notebook/WorldTags', { stubs: STUBS, mutate: mutate('component') }))
  const mapOptions = lazy(async () => {
    const appearance = (await loadUtilities(['appearance'], { stubs: STUBS })).appearance.resolveAppearance('light')

    globalThis.__appearance = appearance

    return loadPage('pages/map', { sources, stubs: STUBS, modules: MAP_MODULES, mutate: mutate('map') })
  })
  const checks = []
  const check = (group, name, run) => checks.push({ group, name, run: async () => run(await (group === 'component' ? componentOptions() : group === 'map' ? mapOptions() : mixinOptions())) })

  const config = { get: (_key, fallback) => fallback }
  const open = async (save, where = scope()) => {
    const database = fakeSave(save)

    return { objects: { body: await tags.loadBodies(database, { GameID: 1, RaceID: where.RaceID, bodyIds: save.bodies.map((row) => row.id) }) }, GameID: 1, RaceID: where.RaceID, campaignId: where.campaignId, branchId: where.branchId, branches: TREE, database }
  }
  const put = async (w, id, tag, save = SAVE(), where = scope()) => {
    const context = await open(save, where)
    const outcome = await saveNow(tags, w.repo, where, { tag, target: { type: 'body', row: context.objects.body.get(id) }, context })

    assert.equal(outcome.ok, true, outcome.message)
  }

  const CAMPAIGN = { campaignId: 'c1', branchId: 'b1', generation: 1 }

  // The mixin on a pseudo instance over the stores and the fake save given; the host's `tagSystemId` is given as data.
  const mixinMounted = (options, { campaign = CAMPAIGN, RaceID = RACE_SHOWN, save = SAVE(), inst = memory(), systemId = 1, data = {}, failing = [] } = {}) => {
    const w = world(m, inst)
    const database = fakeSave(save, { failing })
    const store = { getters: { config, database, GameID: 1, GameTime: 100000, RaceID, 'history/campaign': campaign }, state: { history: { revision: 0 } } }
    const vm = instantiate(options, { $store: store, database, GameID: 1, RaceID, data: { tagFilter: 'all', tagRecords: { repository: w.repo, error: null }, tagBranches: TREE, tagSystemId: systemId, ...data } })

    return { vm, w, database, inst }
  }

  const reads = async (mount) => {
    await mount.vm.runAsync('tagBodiesRead')
    await mount.vm.runAsync('tagBodiesRead')

    return mount
  }

  const choiceOf = (vm, id) => {
    const choice = vm.tagChoices.find((one) => one.id === id)

    assert.ok(choice, `the form offers body ${id}`)

    return choice
  }

  const tagged = async (mount, id, text) => {
    const ok = await mount.vm.tagSave({ row: choiceOf(mount.vm, id).row, tag: text, expected: mount.vm.tagExpect(choiceOf(mount.vm, id).row), scopeKey: mount.vm.tagScopeKey })

    await mount.vm.runAsync('tagBodiesRead')

    return ok
  }

  // ---- mixin --------------------------------------------------------------------------------------------------------

  check('mixin', 'the tags of the race, campaign and branch shown are listed, kept from the form, changed and cleared, and the filter lists the tag asked for', async (options) => {
    const mount = await reads(mixinMounted(options))
    const { vm } = mount

    assert.equal(vm.tagProblem, '')
    assert.equal(vm.tagHint, '')
    assert.deepEqual(vm.tagChoices.map((choice) => choice.name), ['Ceres', 'Earth', 'Halley', 'Luna', 'Mars'])
    assert.equal(await tagged(mount, LUNA, 'Base'), true)
    assert.equal(vm.tagMessage, 'The tag is kept.')
    assert.equal(await tagged(mount, MARS, 'Mine'), true)
    assert.deepEqual(vm.tagEntries.map((entry) => entry.tag), ['Base', 'Mine'])
    vm.tagFilter = 'tag:Mine'
    assert.deepEqual(vm.tagShown.map((entry) => entry.target.name), ['Mars'])
    assert.deepEqual(Object.keys(vm.tagSystems), ['1'])
    assert.equal(vm.tagFilterValue, 'tag:Mine')
    assert.deepEqual(vm.tagSuggestions, ['Base', 'Mine'])

    const entry = vm.tagEntries.find((one) => one.tag === 'Base')

    assert.equal(await vm.tagRetag({ entry, tag: 'Outpost', scopeKey: vm.tagScopeKey }), true)
    assert.equal(vm.tagMessage, 'The tag is changed.')
    assert.deepEqual(vm.tagEntries.map((one) => one.tag), ['Mine', 'Outpost'])
    assert.equal(await vm.tagClear(vm.tagEntries.find((one) => one.tag === 'Outpost')), true)
    assert.equal(vm.tagMessage, 'The tag is cleared.')
    assert.deepEqual(vm.tagEntries.map((one) => one.tag), ['Mine'])
    assert.equal(await vm.tagRetag({ entry: vm.tagEntries[0], tag: 'Mine', scopeKey: vm.tagScopeKey }), true)
    assert.equal(vm.tagMessage, 'The tag is as it was.')
  })

  check('mixin', 'a stored filter that no tag of this branch has is not applied and not overwritten', async (options) => {
    const mount = await reads(mixinMounted(options, { data: { tagFilter: 'tag:Gone' } }))
    const { vm } = mount

    await tagged(mount, EARTH, 'Home')
    assert.equal(vm.tagFilterValue, 'all')
    assert.equal(vm.tagShown.length, 1)
    assert.deepEqual(Object.keys(vm.tagSystems), ['1'])
    assert.equal(vm.tagFilter, 'tag:Gone')
    vm.tagFilter = 'stale'
    assert.equal(vm.tagFilterValue, 'all')
    assert.equal(vm.tagShown.length, 1)
    vm.tagFilter = 'tag:Home'
    assert.equal(vm.tagFilterValue, 'tag:Home')
  })

  check('mixin', 'only the bodies of the picked system are offered, and none when the host has picked none', async (options) => {
    const mount = await reads(mixinMounted(options, { systemId: 2 }))

    assert.deepEqual(mount.vm.tagChoices.map((choice) => choice.name), ['Proxima b'])
    mount.vm.tagSystemId = null
    assert.deepEqual(mount.vm.tagChoices, [])
  })

  check('mixin', 'the bodies the tags link to are read by the page, so a body that is gone reads stale and a tag that is not checked is never stale', async (options) => {
    const inst = memory()
    const w = world(m, inst)

    await put(w, LUNA, 'Base')
    await put(w, EARTH, 'Home')

    const pending = mixinMounted(options, { inst, save: without(SAVE(), LUNA) })

    assert.equal(pending.vm.tagContext, null)
    assert.equal(pending.vm.tagEntries.length, 2)
    assert.equal(pending.vm.tagEntries.every((entry) => !entry.stale && entry.link.status === 'unknown'), true)
    assert.match(pending.vm.tagHint, /Reading the bodies/)
    await reads(pending)
    assert.ok(pending.vm.tagContext)
    assert.equal(pending.vm.tagEntries.find((entry) => entry.tag === 'Base').stale, true)
    assert.equal(pending.vm.tagEntries.find((entry) => entry.tag === 'Home').stale, false)
    assert.ok(pending.database.sent.some(({ sql }) => /SystemBodyID in \(([\d, ]+)\)/.test(sql) && /\b102\b/.test(sql)))
    assert.deepEqual(pending.vm.tagOptions.map((option) => option.value).sort(), ['all', 'stale', 'tag:Base', 'tag:Home'])
    pending.vm.tagFilter = 'stale'
    assert.deepEqual(pending.vm.tagShown.map((entry) => entry.tag), ['Base'])
  })

  check('mixin', 'a read of the bodies made for other IDs, other than the ones the tags link to now, proves nothing and is not used', async (options) => {
    const inst = memory()

    await put(world(m, inst), LUNA, 'Base')

    const mount = await reads(mixinMounted(options, { inst }))

    assert.ok(mount.vm.tagContext)
    mount.vm.tagBodiesRead = { ...mount.vm.tagBodiesRead, requested: new Set() }
    assert.equal(mount.vm.tagBodiesBundle, null)
    assert.equal(mount.vm.tagContext, null)
    assert.equal(mount.vm.tagEntries[0].stale, false)
    mount.vm.tagBodiesRead = { ...mount.vm.tagBodiesRead, requested: new Set([LUNA]), database: { name: 'another save' } }
    assert.equal(mount.vm.tagContext, null)
  })

  check('mixin', 'a read of the bodies that failed names its error and is never taken for bodies that are gone', async (options) => {
    const inst = memory()

    await put(world(m, inst), LUNA, 'Base')

    const mount = await reads(mixinMounted(options, { inst, failing: ['FCT_SystemBody'] }))

    assert.equal(mount.vm.tagBodiesRead.bodies, null)
    assert.match(mount.vm.tagBodiesRead.error, /the save lacks the system body data/)
    assert.equal(mount.vm.tagContext, null)
    assert.equal(mount.vm.tagEntries[0].stale, false)
    assert.match(mount.vm.tagHint, /cannot give its bodies/)
    assert.deepEqual(mount.vm.tagChoices, [])
  })

  check('mixin', 'another race and another branch list none of the tags of this one, and each form is for the scope it was filled in for', async (options) => {
    const inst = memory()
    const first = await reads(mixinMounted(options, { inst }))

    await tagged(first, EARTH, 'Mine')

    const race = await reads(mixinMounted(options, { inst, RaceID: 8 }))
    const branch = await reads(mixinMounted(options, { inst, campaign: { ...CAMPAIGN, branchId: 'b2' } }))
    const campaign = await reads(mixinMounted(options, { inst, campaign: { ...CAMPAIGN, campaignId: 'c2' } }))

    assert.equal(first.vm.tagEntries.length, 1)
    assert.equal(race.vm.tagEntries.length, 0)
    assert.equal(branch.vm.tagEntries.length, 0)
    assert.equal(campaign.vm.tagEntries.length, 0)
    assert.equal(new Set([first, race, branch, campaign].map((one) => one.vm.tagScopeKey)).size, 4)
    assert.equal(world(m, inst).repo.list(scope('b1', 8), { kind: 'world.tag' }).length, 0)
  })

  check('mixin', 'a form filled in for another campaign, race or branch than the one shown is refused and nothing is written, and a clear is not for a form', async (options) => {
    const inst = memory()
    const first = await reads(mixinMounted(options, { inst }))
    const other = await reads(mixinMounted(options, { inst, campaign: { ...CAMPAIGN, branchId: 'b2' } }))
    const row = choiceOf(first.vm, EARTH).row

    assert.equal(await other.vm.tagSave({ row, tag: 'Mine', expected: other.vm.tagExpect(row), scopeKey: first.vm.tagScopeKey }), false)
    assert.match(other.vm.tagMessage, /changed after the form was filled in/)
    assert.equal(other.vm.tagMessageType, 'warning')
    assert.equal(await first.vm.tagSave({ row, tag: 'Mine', expected: first.vm.tagExpect(row), scopeKey: '' }), false)
    assert.equal(inst.files.size, 0)
    assert.equal(await first.vm.tagSave({ row, tag: 'Mine', expected: first.vm.tagExpect(row), scopeKey: first.vm.tagScopeKey }), true)
    assert.equal(first.vm.tagBusy, false)
  })

  check('mixin', 'the lineage of the campaign\'s branches is read only when the registry can be read, and otherwise left empty and never throws', async (options) => {
    const mount = mixinMounted(options, { data: { tagBranches: null } })

    assert.equal(await mount.vm.runAsync('tagBranches'), null)

    const unsettled = mixinMounted(options, { campaign: null })

    assert.equal(await unsettled.vm.runAsync('tagBranches'), null)
    assert.equal(unsettled.vm.tagScope, null)
    assert.equal(unsettled.vm.tagScopeKey, '')
    assert.equal(unsettled.vm.tagEntries.length, 0)
    assert.match(unsettled.vm.tagHint, /not settled/)
  })

  // ---- component ----------------------------------------------------------------------------------------------------

  const rowsOf = (options, entries, startYear = 2050) => instantiate(options, { $store: { getters: {} }, data: { entries, startYear } }).rows

  check('component', 'a stale tag says why it is stale and what it was, and a body that is not there is told from one that holds the ID of another', async (options) => {
    const w = world(m)

    await saveNow(tags, w.repo, scope(), { tag: 'Base', target: { type: 'body', row: (await open(SAVE())).objects.body.get(LUNA) }, context: await open(SAVE()) })

    const gone = rowsOf(options, tags.readTags(w.repo, scope(), await open(without(SAVE(), LUNA))).entries)[0]
    const given = rowsOf(options, tags.readTags(w.repo, scope(), await open(edited(SAVE(), (copy) => { found(copy.bodies, LUNA).bodyClass = 3 }))).entries)[0]
    const fine = rowsOf(options, tags.readTags(w.repo, scope(), await open(SAVE())).entries)[0]

    assert.equal(gone.stale, true)
    assert.match(gone.staleText, /no longer in this save/)
    assert.match(gone.staleText, /Luna in Sol/)
    assert.match(given.staleText, /no longer the one that was tagged/)
    assert.equal(given.stale, true)
    assert.notEqual(gone.staleText, given.staleText)
    assert.equal(fine.rewound, '')
  })

  check('component', 'a save from before the tag was made is told only where the tag does not match: with the date the system was found, and a matching tag in it is not', async (options) => {
    const w = world(m)
    const context = await open(SAVE())

    await saveNow(tags, w.repo, scope(), { tag: 'Target', target: { type: 'body', row: context.objects.body.get(PROXIMA) }, context })
    await saveNow(tags, w.repo, scope(), { tag: 'Home', target: { type: 'body', row: context.objects.body.get(EARTH) }, context })

    const earlier = scope('b1', 7, 'c1', 1500)
    const save = edited(SAVE(), (copy) => { copy.systems = copy.systems.filter((one) => one.id !== 2) })
    const rows = rowsOf(options, tags.readTags(w.repo, earlier, await open(save, earlier)).entries)
    const mismatch = rows.find((row) => row.tag === 'Target')
    const match = rows.find((row) => row.tag === 'Home')

    assert.match(mismatch.rewound, /from before the tag was made/)
    assert.match(mismatch.rewound, /found on /)
    assert.equal(match.ahead, true)
    assert.equal(match.rewound, '')
    assert.equal(rowsOf(options, tags.readTags(w.repo, scope(), await open(SAVE())).entries).every((row) => row.rewound === ''), true)
    assert.equal(rowsOf(options, [{ ...mismatch, discoveredAt: null }])[0].rewound.includes('found on'), false)
  })

  check('component', 'the form is dropped when the campaign, race or branch shown changes, and a body that is no longer offered is dropped from it', async (options) => {
    const vm = instantiate(options, { $store: { getters: {} }, data: { entries: [], pick: { id: 5 }, text: 'Mine', filledFor: 'c1|7|b1', editing: 'x', confirm: 'y' } })

    options.watch.scopeKey.call(vm)
    assert.equal(vm.pick, null)
    assert.equal(vm.text, '')
    assert.equal(vm.filledFor, null)
    assert.equal(vm.editing, null)
    assert.equal(vm.confirm, null)
    vm.pick = { id: 5 }
    options.watch.choices.call(vm, [{ id: 6 }])
    assert.equal(vm.pick, null)
    vm.pick = { id: 5 }
    options.watch.choices.call(vm, [{ id: 5 }, { id: 6 }])
    assert.deepEqual(vm.pick, { id: 5 })
  })

  // The change and the clear of a listed tag are made over the revision the tag had when the draft was opened: a change made elsewhere meanwhile (the other page, another window) is a conflict, and is never written over.
  const conflictOf = async (options, open_, finish) => {
    const w = world(m)
    const context = await open(SAVE())
    const last = []

    await saveNow(tags, w.repo, scope(), { tag: 'Base', target: { type: 'body', row: context.objects.body.get(LUNA) }, context })

    const entriesNow = () => tags.readTags(w.repo, scope(), context).entries
    const retag = async (call) => { const outcome = await saveNow(tags, w.repo, scope(), { entry: call.entry, tag: call.tag, context }); last.push(outcome); return outcome.ok }
    const clear = async (entry) => { const outcome = await tags.clearTag(w.repo, scope(), entry); last.push(outcome); return outcome.ok }
    const vm = instantiate(options, { $store: { getters: {} }, data: { entries: entriesNow(), startYear: 2050, retag, clear, scopeKey: 'k' } })
    const row = vm.rows[0]

    await open_(vm, row)
    // The same tag is changed elsewhere and the list is read again.
    assert.equal((await saveNow(tags, w.repo, scope(), { entry: entriesNow()[0], tag: 'Elsewhere', context })).ok, true)
    vm.entries = entriesNow()
    assert.equal(vm.entries[0].revision, 2)
    await finish(vm, row)

    const kept = entriesNow()

    assert.equal(kept.length, 1)
    assert.equal(kept[0].tag, 'Elsewhere', 'the change made elsewhere is kept')
    assert.equal(kept[0].revision, 2, 'nothing was written over it')
    assert.equal(last.length, 1)
    assert.equal(last[0].ok, false)
    assert.equal(last[0].code, 'revision-conflict')

    return vm
  }

  check('component', 'a change of a tag saved after the same tag was changed elsewhere is a conflict, and the change made elsewhere is kept', async (options) => {
    const vm = await conflictOf(options, (one, row) => { one.edit(row); one.editText = 'Draft' }, (one, row) => one.change(row))

    assert.equal(vm.editing, vm.rows[0].uuid, 'the draft stays open after a conflict')
  })

  check('component', 'a clear of a tag confirmed after the same tag was changed elsewhere is a conflict, and the tag is kept', async (options) => {
    await conflictOf(options, (one, row) => one.ask(row), (one, row) => one.remove(row))
  })

  // The top form of a page, over the page's own mixin: a body is picked, the same body's tag is changed or made elsewhere, and the form saves. It is a conflict that keeps the draft and the tag made elsewhere; the form that picks the body again saves.
  const formOf = (options, vm) => instantiate(options, { $store: { getters: {} }, data: { entries: vm.tagShown, choices: vm.tagChoices, scopeKey: vm.tagScopeKey, expect: vm.tagExpect, save: vm.tagSave, retag: vm.tagRetag, clear: vm.tagClear } })

  const createOver = async (options, { vm, w, id, save, start }) => {
    const form = formOf(options, vm)
    const choice = choiceOf(vm, id)
    const storedOf = async () => tags.readTags(w.repo, scope(), await open(save)).entries.filter((entry) => entry.target.id === id)
    const [before] = await storedOf()

    assert.equal(start === 'tagged' ? before.tag : before, start === 'tagged' ? before.tag : undefined)
    form.pick = choice
    form.picked(choice)
    form.text = 'Draft'
    await put(w, id, 'Elsewhere', save)
    vm.tagRevision += 1
    await reads({ vm })
    form.entries = vm.tagShown
    await form.add()

    const [kept, ...rest] = await storedOf()

    assert.equal(rest.length, 0)
    assert.equal(kept.tag, 'Elsewhere', `${start}: the tag made or changed elsewhere is kept`)
    assert.equal(kept.revision, start === 'tagged' ? 2 : 1, `${start}: nothing was written over it`)
    assert.equal(form.pick, choice, `${start}: the draft keeps its body`)
    assert.equal(form.text, 'Draft', `${start}: the draft keeps its text`)
    assert.equal(vm.tagMessageType, 'warning')

    // The body picked again is read as it is now, and the form saves over it.
    form.pick = null
    form.pick = choice
    form.picked(choice)
    await form.add()

    const [saved, ...more] = await storedOf()

    assert.equal(more.length, 0)
    assert.equal(saved.tag, 'Draft', `${start}: the form picked again saves`)
    assert.equal(saved.revision, start === 'tagged' ? 3 : 2)
    assert.equal(form.pick, null)
  }

  for (const start of ['tagged', 'untagged']) {
    check('component', `the top form of the Notebook with the body ${start} when it was picked: a tag changed or made elsewhere since is a conflict that keeps the draft, a filter that hides the tag changes nothing, and the body picked again saves`, async (options) => {
      const mount = await reads(mixinMounted(await mixinOptions(), { save: SAVE() }))

      if (start === 'tagged') {
        assert.equal(await tagged(mount, EARTH, 'Base'), true)
        assert.equal(await tagged(mount, LUNA, 'Other'), true)
        mount.vm.tagFilter = 'tag:Other'
        assert.deepEqual(mount.vm.tagShown.map((entry) => entry.tag), ['Other'], 'the filter hides the tag of the body picked')
      }

      await createOver(options, { vm: mount.vm, w: mount.w, id: EARTH, save: SAVE(), start })
    })

    check('component', `the top form of the Galaxy Map's side panel with the body ${start} when it was picked: a tag changed or made elsewhere since is a conflict that keeps the draft, and the body picked again saves`, async (options) => {
      const mount = await mapMounted(await mapOptions(), { made: start === 'tagged' ? [['900', 'Mine']] : [], selected: ['9'] })

      await createOver(options, { vm: mount.vm, w: mount.w, id: 900, save: MAP_SAVE(), start })
    })
  }

  // The top form over the app's own store client, another window writing between the read and the swap of the form's save: the save is a conflict, the other window's write is the only one stored, and the form keeps the body and the text.
  for (const start of ['tagged', 'untagged']) {
    check('component', `the top form of the Notebook with the body ${start} when another window writes between its read and its swap: the save is a conflict that keeps the draft and leaves the other window's tag alone`, async (options) => {
      const context = await open(SAVE())
      const win = interleaved(m, start === 'tagged' ? rivalChange(m, scope(), context, 'Elsewhere') : rivalCreate(m, scope(), context, LUNA, 'Elsewhere'))
      const mount = await reads(mixinMounted(await mixinOptions(), { inst: win.firstInst }))

      if (start === 'tagged') {
        assert.equal(await tagged(mount, LUNA, 'One'), true)
      }

      const form = formOf(options, mount.vm)
      const choice = choiceOf(mount.vm, LUNA)

      form.pick = choice
      form.picked(choice)
      form.text = 'Draft'
      win.arm()
      await form.add()
      assert.equal(win.swaps(), 1, `${start}: the first swap failed and the save was not made again`)
      assert.deepEqual(tags.readTags(win.other, scope(), context).entries.map((entry) => `${entry.tag}@${entry.revision}`), [start === 'tagged' ? 'Elsewhere@2' : 'Elsewhere@1'])
      assert.equal(form.pick, choice, `${start}: the draft keeps its body`)
      assert.equal(form.text, 'Draft', `${start}: the draft keeps its text`)
      assert.equal(mount.vm.tagMessageType, 'warning')
    })
  }

  // ---- map ----------------------------------------------------------------------------------------------------------

  // The Galaxy Map on a pseudo instance: the tags made in the full save, read in `save`.
  const mapMounted = async (options, { marks = ['tags'], made = [['900', 'Mine']], save = MAP_SAVE(), data = {}, inst = memory(), selected = [] } = {}) => {
    const w = world(m, inst)

    for (const [id, text] of made) {
      await put(w, Number(id), text, MAP_SAVE())
    }

    const database = fakeSave(save)
    const store = { getters: { StartYear: 2050, GameTime: 100000, racePrefix: null, config, database, 'history/campaign': CAMPAIGN }, state: { history: { revision: 0 } } }
    const vm = instantiate(options, { $store: store, database, GameID: 1, RaceID: RACE_SHOWN, data: { loadErrors: {}, systems: MAP_SYSTEMS, jumpPoints: [], sectors: [], aliens: [], features: Object.fromEntries(MAP_SYSTEMS.map((one) => [String(one.SystemID), NO_FEATURES])), habitability: null, formulaVersion: null, hierarchy: 'restrained', layer: 'geological', borders: 'none', activateSnackbar: () => {}, marks, selectedIds: selected, tagRecords: { repository: w.repo, error: null }, tagBranches: TREE, ...data } })

    await vm.runAsync('tagBodiesRead')
    await vm.runAsync('tagBodiesRead')

    return { vm, w, inst }
  }

  const rowOf = (vm, id) => vm.systemRows.find((row) => row.SystemID === id)
  const glyphs = (vm, id) => vm.glyphsOf(rowOf(vm, id)).map((glyph) => glyph.name).filter((name) => name.startsWith('tags'))

  check('map', 'a system with a tagged body shows the tagged glyph only while the mark is on, and a system whose tagged bodies are all gone shows its stale form', async (options) => {
    const live = await mapMounted(options, { made: [['900', 'Mine'], ['800', 'Mine'], ['801', 'Other']] })

    assert.deepEqual([9, 80, 50, 7].map((id) => glyphs(live.vm, id)), [['tags'], ['tags'], [], []])

    const stale = await mapMounted(options, { made: [['900', 'Mine'], ['800', 'Mine'], ['801', 'Other']], save: edited(MAP_SAVE(), (copy) => { copy.bodies = copy.bodies.filter((row) => row.systemId !== 80) }) })

    assert.deepEqual([9, 80, 50, 7].map((id) => glyphs(stale.vm, id)), [['tags'], ['tags-stale'], [], []])

    const half = await mapMounted(options, { made: [['800', 'Mine'], ['801', 'Other']], save: without(MAP_SAVE(), 800) })

    assert.deepEqual(glyphs(half.vm, 80), ['tags'])

    const off = await mapMounted(options, { marks: [] })

    assert.deepEqual([9, 80, 50, 7].map((id) => glyphs(off.vm, id)), [[], [], [], []])
    assert.equal(rowOf(live.vm, 9).SystemID, 9)
  })

  check('map', 'the tag filter marks and keeps at full strength the systems that hold a body with the tag, and fades the others, and a stored filter no tag matches fades nothing', async (options) => {
    const made = [['900', 'Mine'], ['800', 'Other']]
    const all = await mapMounted(options, { made })

    assert.equal([9, 80, 50, 7].some((id) => all.vm.fades(rowOf(all.vm, id), false)), false)

    const filtered = await mapMounted(options, { made, data: { tagFilter: 'tag:Mine' } })

    assert.deepEqual([9, 80, 50, 7].map((id) => glyphs(filtered.vm, id)), [['tags'], [], [], []])
    assert.deepEqual([9, 80, 50, 7].map((id) => filtered.vm.fades(rowOf(filtered.vm, id), false)), [false, true, true, true])

    const unmatched = await mapMounted(options, { made, data: { tagFilter: 'tag:Gone' } })

    assert.equal([9, 80, 50, 7].some((id) => unmatched.vm.fades(rowOf(unmatched.vm, id), false)), false)
    assert.deepEqual(glyphs(unmatched.vm, 9), ['tags'])
    assert.equal(unmatched.vm.tagFilter, 'tag:Gone')
    assert.deepEqual(filtered.vm.tagItems.map((item) => item.value), ['all', 'tag:Mine', 'tag:Other'])
    assert.deepEqual(filtered.vm.tagItems.map((item) => item.text), ['All tags (2)', 'Mine (1)', 'Other (1)'])
  })

  check('map', 'choosing a tag turns the mark of the tagged bodies on so the systems it finds show, and choosing all tags does not', async (options) => {
    const mount = await mapMounted(options, { marks: [] })

    mount.vm.chooseTag('all')
    assert.deepEqual(mount.vm.marks, [])
    mount.vm.chooseTag('tag:Mine')
    assert.equal(mount.vm.tagFilter, 'tag:Mine')
    assert.deepEqual(mount.vm.marks, ['tags'])
    mount.vm.chooseTag('stale')
    assert.deepEqual(mount.vm.marks, ['tags'])
    assert.equal(mount.vm.tagFilter, 'stale')
  })

  check('map', 'the side panel lists the tags of the system selected only, and offers the bodies of that system to tag', async (options) => {
    const mount = await mapMounted(options, { made: [['900', 'Mine'], ['800', 'Other']], selected: ['9'] })
    const { vm } = mount

    assert.equal(vm.tagSystemId, 9)
    assert.deepEqual(vm.panelTags.map((entry) => entry.tag), ['Mine'])
    assert.deepEqual(vm.tagChoices.map((choice) => choice.name), ['Alpha I', 'Alpha II'])
    vm.selectedIds = ['80']
    assert.deepEqual(vm.panelTags.map((entry) => entry.tag), ['Other'])
    vm.tagFilter = 'tag:Mine'
    assert.deepEqual(vm.panelTags.map((entry) => entry.tag), ['Other'])
    vm.selectedIds = ['50']
    assert.deepEqual(vm.panelTags, [])
    vm.selectedIds = []
    assert.equal(vm.tagSystemId, null)
    assert.deepEqual(vm.tagChoices, [])
  })

  check('map', 'tagging, changing and clearing a body on the map never changes a cluster, a pin, the layout or a border, and never writes the save', async (options) => {
    const mount = await mapMounted(options, { made: [], selected: ['9'], data: { groups: [[9, 80]], pinned: ['9'], locked: true, borders: 'groups', layer: 'groups' } })
    const { vm } = mount
    const view = () => JSON.stringify([vm.groups, vm.pinned, vm.locked, vm.borders, vm.layer, vm.marks, vm.systemRows.map((row) => [row.id, row.Xcor, row.Ycor])])

    const before = view()

    assert.equal(await vm.tagSave({ row: choiceOf(vm, 901).row, tag: 'Moon', expected: vm.tagExpect(choiceOf(vm, 901).row), scopeKey: vm.tagScopeKey }), true)
    await vm.runAsync('tagBodiesRead')
    assert.equal(vm.tagEntries.length, 1)
    assert.equal(await vm.tagRetag({ entry: vm.tagEntries[0], tag: 'Planet', scopeKey: vm.tagScopeKey }), true)
    assert.equal(vm.tagEntries[0].tag, 'Planet')
    assert.equal(await vm.tagClear(vm.tagEntries[0]), true)
    assert.equal(vm.tagEntries.length, 0)
    assert.equal(view(), before)
    vm.database.sent.forEach(({ sql }) => assert.match(sql, /^select /))
    assert.deepEqual(vm.groups, [[9, 80]])
  })

  // The filter each page keeps, on the shipped page over the real persisted-view mixin and an in-memory settings store: kept for the race, restored on reopening, and never shared with another race or campaign.
  const keptFilter = async (name, key) => {
    const text = fs.readFileSync(path.join(root, 'src', 'renderer', 'mixins', 'persisted-view.js'), 'utf8')

    globalThis.__appearance = (await loadUtilities(['appearance'], { stubs: STUBS })).appearance.resolveAppearance('light')

    const options = await loadPage(`pages/${name}`, { sources, stubs: STUBS, modules: { ...MAP_MODULES, 'mixins/persisted-view': `${text}\n// ${name}\nglobalThis.__declaredViews = declaredViews\n` } })
    const declared = globalThis.__declaredViews().find((view) => view.key === key)
    const settings = new Map()
    const config = { get: (setting) => settings.get(setting), set: (setting, value) => settings.set(setting, value) }
    const mount = (prefix) => instantiate(options, { $store: { getters: { config, racePrefix: prefix, database: null, GameID: 1, RaceID: 7, StartYear: 2050, GameTime: 1, 'history/campaign': CAMPAIGN }, state: { history: { revision: 0 } } }, GameID: 1, RaceID: 7 })

    assert.ok(declared, `${name} declares ${key}`)
    assert.equal(declared.scope, 'race')
    assert.equal(declared.default, 'all')

    const first = mount('campaign.c1.race.7')

    assert.equal(first.tagFilter, 'all')
    first.saveView('tagFilter', 'tag:Mine')
    assert.equal(settings.get(`campaign.c1.race.7.${key}`), 'tag:Mine')
    assert.equal(settings.has(key), false, 'the filter is kept for the race, not for the app')
    assert.equal(mount('campaign.c1.race.7').tagFilter, 'tag:Mine')
    assert.equal(mount('campaign.c1.race.8').tagFilter, 'all')
    assert.equal(mount('campaign.c2.race.7').tagFilter, 'all')
  }

  check('mixin', 'the tag filter of the Galaxy Map is a per-race view value: kept under the race, restored when the page is opened again, and not seen by another race or campaign', async () => keptFilter('map', 'mapTagFilter'))

  check('mixin', 'the tag filter of the Notebook is a per-race view value: kept under the race, restored when the page is opened again, and not seen by another race or campaign', async () => keptFilter('notebook', 'notebookTagFilter'))

  return checks
}

// ---- Mutants ---------------------------------------------------------------------------------------------------------

const UTILITY_MUTATIONS = [
  { name: 'tagging a body changes the tag of the body that shares its system', file: 'world-tags.js', find: 'one.links[0] && one.links[0].id === row.id && one.links[0].fingerprint === WORLD_TARGETS.body.fingerprint(row)', replace: 'one.links[0] && one.target.systemId === row.systemId', fails: ['moon: tagging a moon tags that moon only'] },
  { name: 'a body that has a tag is given another record', file: 'world-tags.js', find: 'const same = row ? matchOf(', replace: 'const same = false ? matchOf(', fails: ['edit: a tag is made, changed and cleared'] },
  { name: 'a stale tag of an ID is changed into the tag of the body that holds the ID now', file: 'world-tags.js', find: ' && one.links[0].fingerprint === WORLD_TARGETS.body.fingerprint(row)', replace: '', fails: ['stale: an ID that another body holds now reads changed'] },
  { name: 'a tag is made over whatever the body has now', file: 'world-tags.js', find: 'if (asked.uuid === null ? !same : same && same.uuid === asked.uuid && same.revision === asked.revision) {', replace: 'if (true) {', fails: ['edit: a tag is made over what the body had'] },
  { name: 'a tag changed elsewhere is written over when the body was tagged', file: 'world-tags.js', find: ' && same.revision === asked.revision) {', replace: ') {', fails: ['edit: a tag is made over what the body had'] },
  { name: 'a tag made elsewhere is written over when the body had none', file: 'world-tags.js', find: 'asked.uuid === null ? !same :', replace: 'asked.uuid === null ? true :', fails: ['edit: a tag is made over what the body had'] },
  { name: 'a tag cleared elsewhere is made again from the old form', file: 'world-tags.js', find: ': same && same.uuid === asked.uuid', replace: ': !same || same.uuid === asked.uuid', fails: ['edit: a tag is made over what the body had'] },
  { name: 'a tag is made with no expectation', file: 'world-tags.js', find: 'return { ok: false, code: \'invalid-tag\', message: \'A tag is made over what the body had when it was picked: the expectation is missing\' }', replace: 'void 0', fails: ['edit: a tag is made over what the body had'] },
  { name: 'the expectation of a tag is checked outside the write only', file: 'world-tags.js', find: ', context: context || undefined, precondition }', replace: ' }', fails: ['edit: a tag written while another window writes'] },
  { name: 'the expectation of a tag is checked in the write on the first attempt only', file: 'scenario-records.js', find: 'if (precondition) {', replace: 'if (precondition && !precondition.ran && (precondition.ran = true)) {', fails: ['edit: a tag written while another window writes'] },
  { name: 'a tag cleared by another window while it is changed is not a conflict', file: 'world-tags.js', find: "if (target && error && error.name === 'RecordsRefused' && error.code === 'not-found') {", replace: 'if (false) {', fails: ['edit: a tag written while another window writes'] },
  { name: 'a changed link is not stale', file: 'world-tags.js', find: "const stale = Boolean(link) && (link.status === 'missing' || link.status === 'changed')", replace: "const stale = Boolean(link) && link.status === 'missing'", fails: ['stale: an ID that another body holds now reads changed', 'rewind: a save in which the system was found at another time'] },
  { name: 'a link that is not checked is stale', file: 'world-tags.js', find: "const stale = Boolean(link) && (link.status === 'missing' || link.status === 'changed')", replace: "const stale = Boolean(link) && link.status !== 'linked'", fails: ['stale: a body that is not read'] },
  { name: 'a stale tag is found in the system its body has now', file: 'world-tags.js', find: 'lastKnown: stale }', replace: 'lastKnown: false }', fails: ['stale: a body that is gone leaves its tag listed'] },
  { name: 'a tag is listed on another branch than its own', file: 'world-tags.js', find: 'listed = repository.list(scope, { kind: TAG_KIND', replace: "listed = repository.list({ ...scope, branchId: 'b1' }, { kind: TAG_KIND", fails: ['isolation: a tag is kept for its branch'] },
  { name: 'a tag is listed for another race than its own', file: 'world-tags.js', find: 'listed = repository.list(scope, { kind: TAG_KIND', replace: 'listed = repository.list({ ...scope, RaceID: 7 }, { kind: TAG_KIND', fails: ['isolation: another race lists none'] },
  { name: 'a tag is listed for another campaign than its own', file: 'world-tags.js', find: 'listed = repository.list(scope, { kind: TAG_KIND', replace: "listed = repository.list({ ...scope, campaignId: 'c1' }, { kind: TAG_KIND", fails: ['isolation: another campaign lists none'] },
  { name: 'a new tag is shared with the whole campaign', file: 'world-tags.js', find: "policy: 'branch', links", replace: "policy: 'campaign', links", fails: ['isolation: a tag is kept for its branch'] },
  { name: 'the same text is written again', file: 'world-tags.js', find: 'if (edited.tag === payload.tag) {', replace: 'if (false) {', fails: ['edit: the same text changes nothing'] },
  { name: 'a clear is made over whatever revision is stored', file: 'world-tags.js', find: 'repository.delete(scope, entry.uuid, entry.revision)', replace: 'repository.delete(scope, entry.uuid, repository.list(scope, { kind: TAG_KIND }).find((item) => item.record.uuid === entry.uuid).record.revision)', fails: ['edit: an edit or a clear made over a revision'] },
  { name: 'an edit is made over whatever revision is stored', file: 'world-tags.js', find: 'repository.update(scope, edited.uuid, edited.revision,', replace: 'repository.update(scope, edited.uuid, repository.list(scope, { kind: TAG_KIND }).find((item) => item.record.uuid === edited.uuid).record.revision,', fails: ['edit: an edit or a clear made over a revision'] },
  { name: 'the text of a tag is kept as typed', file: 'world-tags.js', find: "export const tagTextOf = (value) => (typeof value === 'string' ? value.replace(/\\s+/g, ' ').trim() : value)", replace: 'export const tagTextOf = (value) => value', fails: ['edit: a tag is kept with its ends trimmed', 'edit: the same text changes nothing'] },
  { name: 'a tag of any length is valid', file: 'world-tags.js', find: 'payload.tag.length > TAG_LENGTH || ', replace: '', fails: ['edit: an empty, blank, too long'] },
  { name: 'a tag with a field of its own is valid', file: 'world-tags.js', find: ".filter((key) => !['tag', 'target'].includes(key))", replace: '.filter(() => false)', fails: ['edit: an empty, blank, too long'] },
  { name: 'a stale tag takes the name of the body that holds its ID now when it is changed', file: 'world-tags.js', find: "const row = entry.link && entry.link.status === 'linked' && bodies instanceof Map ? bodies.get(kept.id) || null : null", replace: 'const row = bodies instanceof Map ? bodies.get(kept.id) || null : null', fails: ['edit: a stale tag is changed without a new link'] },
  { name: 'a filter value is the tag text itself', file: 'world-tags.js', find: 'export const tagValue = (tag) => `tag:#{tag}`', replace: 'export const tagValue = (tag) => tag', fails: ['filter: the tag filter finds a tag by its text'] },
  { name: 'a stale tag is left out of the filter of its text', file: 'world-tags.js', find: 'entries.filter((entry) => tagValue(entry.tag) === value)', replace: 'entries.filter((entry) => !entry.stale && tagValue(entry.tag) === value)', fails: ['filter: the tag filter finds a tag by its text'] },
  { name: 'the stale choice is always offered', file: 'world-tags.js', find: '...(stale ? [{ value: STALE_TAGS', replace: '...(true ? [{ value: STALE_TAGS', fails: ['filter: a stale tag is listed under its own text'] },
  { name: 'a stale system is told by one stale tag', file: 'world-tags.js', find: 'systems[key].stale = systems[key].stale && entry.stale', replace: 'systems[key].stale = systems[key].stale || entry.stale', fails: ['filter: the tags are grouped by system'] },
  { name: 'a stale tag is grouped in no system', file: 'world-tags.js', find: 'entries.filter((entry) => entry.place.systemId !== null).forEach', replace: 'entries.filter((entry) => entry.place.systemId !== null && !entry.stale).forEach', fails: ['filter: the tags are grouped by system'] },
  { name: 'a link is made against whatever the form holds', file: 'world-tags.js', find: "const checked = target ? checkLink(context, scope, target, WORLD_TARGETS, 'tag') : null", replace: 'const checked = target ? { ok: true, row: target.row } : null', fails: ['scope: a tag is made only against the bodies of the race', 'scope: a tag is made only for a body that is there as it was picked', 'known: a body of a system the race does not know'] },
  { name: 'the link does not keep the branch it was made on', file: 'world-tags.js', find: 'origin: { campaignId: scope.campaignId, branchId: scope.branchId } } : keptTarget', replace: "origin: { campaignId: scope.campaignId, branchId: 'b1' } } : keptTarget", fails: ['scope: the link keeps the name'] },
  { name: 'a save before the tag is never ahead', file: 'world-tags.js', find: "ahead: item.flags.includes('ahead'),", replace: 'ahead: false,', fails: ['rewind: a save from before the system was found', 'rewind: a save in which the system was found at another time'] },
  { name: 'the time a system was found is read from the wrong part of the fingerprint', file: 'world-tags.js', find: 'const DISCOVERED_PART = NOTE_TARGETS.body.created + 1', replace: 'const DISCOVERED_PART = NOTE_TARGETS.body.created', fails: ['rewind: a save from before the system was found', 'saves: on the owner\'s saves a tag made in the latest save'] },
  { name: 'a kind of the body is not named', file: 'world-tags.js', find: 'const CLASS_PART = 4', replace: 'const CLASS_PART = 5', fails: ['moon: a planet, a moon, an asteroid and a comet'] },
  { name: 'a tag is on any kind of object', file: 'world-tags.js', find: "if (type !== 'body') {\n      throw new Error(`#{type} is not a kind of object a tag is about`)\n    }\n\n    return noteAdapter", replace: 'return noteAdapter', fails: ['backup: the adapter is for bodies only'] },
  { name: 'a tag that names another kind of object is valid', file: 'world-tags.js', find: "target.type === 'body' && (isText(target.id)", replace: '(isText(target.id)', fails: ['backup: the adapter is for bodies only'] },
  { name: 'keeping a tag writes to the save', file: 'world-tags.js', find: "    if (target && !(isObject(target) && target.type === 'body' && isObject(target.row))) {", replace: "    if (context && context.database) {\n      await context.database.query('delete from FCT_Fleet where FleetID = 0')\n    }\n\n    if (target && !(isObject(target) && target.type === 'body' && isObject(target.row))) {", fails: ['reads: every query is a select'] },
  { name: 'a write is sent to the save with the bodies', file: 'economy-notes.js', find: '  return bodies\n}', replace: "  await database.query('update FCT_SystemBody set SystemBodyID = SystemBodyID')\n\n  return bodies\n}", fails: ['reads: every query is a select', 'saves: on the owner\'s saves a body that was never surveyed'] },
  { name: 'a tag whose body is gone is rebound to the body with the same content', file: 'economy-notes.js', find: 'return objects.get(link.id) || null', replace: 'return objects.get(link.id) || [...objects.values()].find((row) => targetOf(link.type).fingerprint(row) === link.fingerprint) || null', fails: ['stale: a tag whose body is gone is never relinked'] },
  { name: 'a body is not told by its place', file: 'economy-notes.js', find: "present(row.planetNumber), present(row.orbitNumber), present(row.bodyClass), present(row.bodyTypeId), present(row.discovered)].join('|'),", replace: "present(row.discovered)].join('|'),", fails: ['stale: an ID that another body holds now reads changed', 'scope: a tag is made only for a body that is there as it was picked'] },
  { name: 'a body is told by its name', file: 'economy-notes.js', find: "fingerprint: (row) => ['body', present(row.systemId),", replace: "fingerprint: (row) => ['body', row.name, present(row.systemId),", fails: ['stale: no fingerprint holds a name', 'stale: a renamed body keeps its tag linked'] },
  { name: 'the picker offers the bodies of every system', file: 'economy-notes.js', find: "(type !== 'body' || row.systemId === systemId)", replace: 'true', fails: ['known: a body of a system the race does not know'] },
  { name: 'only the surveyed bodies of a known system are known', file: 'economy-notes.js', find: 'FCT_SystemBody.BodyClass in (#{BODY_CLASSES}) and #{filter}', replace: 'FCT_SystemBody.BodyClass in (#{BODY_CLASSES}) and exists (select 1 from FCT_SystemBodySurveys where FCT_SystemBodySurveys.SystemBodyID = FCT_SystemBody.SystemBodyID and FCT_SystemBodySurveys.RaceID = :RaceID) and #{filter}', fails: ['saves: on the owner\'s saves a body that was never surveyed'] },
  { name: 'the bodies are read all at once', file: 'economy-notes.js', find: 'for (const batch of batchesOf(bodyIds.filter((id) => Number.isInteger(id)), BODIES_PER_READ)) {', replace: 'for (const batch of batchesOf(bodyIds.filter((id) => Number.isInteger(id)), 100000)) {', fails: ['reads: the bodies are read by ID in batches'] },
  { name: 'a failed read of the bodies is taken for no bodies', file: 'economy-notes.js', find: '    keep((await database.query(bodiesByIdSql(batch), { replacements }))[0])', replace: '    keep((await database.query(bodiesByIdSql(batch), { replacements }).catch(() => [[]]))[0])', fails: ['stale: a body that is not read'] },
  { name: 'a link is made against the objects of another race', file: 'history-milestones.js', find: 'context.RaceID !== scope.RaceID', replace: 'false', fails: ['scope: a tag is made only against the bodies of the race'] },
  { name: 'a link is made against the objects of another campaign or branch', file: 'history-milestones.js', find: ' || context.campaignId !== scope.campaignId || context.branchId !== scope.branchId) {', replace: ') {', fails: ['scope: a tag is made only against the bodies of the race'] },
  { name: 'a link is made to a body that is not as it was picked', file: 'history-milestones.js', find: 'if (!current || linkTypeOf(link.type, types).fingerprint(current) !== linkTypeOf(link.type, types).fingerprint(link.row)) {', replace: 'if (!current) {', fails: ['scope: a tag is made only for a body that is there as it was picked'] },
]

const MIXIN = 'mixin'

const PAGE_MUTATIONS = [
  { name: 'the page reads the tags of another race', target: MIXIN, find: 'scopeOf({ campaign: this.tagResolved, RaceID: this.RaceID, gameTime: this.GameTime })', replace: 'scopeOf({ campaign: this.tagResolved, RaceID: 7, gameTime: this.GameTime })', fails: ['mixin: another race and another branch list none'] },
  { name: 'the page reads the tags of another branch', target: MIXIN, find: 'scopeOf({ campaign: this.tagResolved, RaceID: this.RaceID, gameTime: this.GameTime })', replace: "scopeOf({ campaign: this.tagResolved && { ...this.tagResolved, branchId: 'b1' }, RaceID: this.RaceID, gameTime: this.GameTime })", fails: ['mixin: another race and another branch list none'] },
  { name: 'the scope of a form leaves out the branch', target: MIXIN, find: '[scope.campaignId, scope.RaceID, scope.branchId].join', replace: '[scope.campaignId, scope.RaceID].join', fails: ['mixin: another race and another branch list none', 'mixin: a form filled in for another'] },
  { name: 'the tag filter is kept for the app and not for the race', target: MIXIN, find: "default: ALL_TAGS, scope: 'race' })", replace: "default: ALL_TAGS, scope: 'app' })", fails: ['mixin: the tag filter of the Galaxy Map', 'mixin: the tag filter of the Notebook'] },
  { name: 'the tag filter is not applied', target: MIXIN, find: 'return filterByTag(this.tagEntries, this.tagFilterValue)', replace: 'return this.tagEntries', fails: ['mixin: the tags of the race, campaign and branch shown', 'map: the tag filter marks'] },
  { name: 'a stored filter that no tag has is applied', target: MIXIN, find: 'return this.tagOptions.some((option) => option.value === this.tagFilter) ? this.tagFilter : ALL_TAGS', replace: 'return this.tagFilter', fails: ['mixin: a stored filter that no tag', 'map: the tag filter marks'] },
  { name: 'a stored filter that no tag has is replaced', target: MIXIN, find: 'return this.tagOptions.some((option) => option.value === this.tagFilter) ? this.tagFilter : ALL_TAGS', replace: 'if (!this.tagOptions.some((option) => option.value === this.tagFilter)) {\n        this.tagFilter = ALL_TAGS\n      }\n\n      return this.tagFilter', fails: ['mixin: a stored filter that no tag'] },
  { name: 'the bodies the tags link to are not read', target: MIXIN, find: 'const bodyIds = this.tagBodyIds', replace: 'const bodyIds = []', fails: ['mixin: the bodies the tags link to are read by the page'] },
  { name: 'a read of the bodies made for other IDs counts', target: MIXIN, find: ' && this.tagBodyIds.every((id) => bundle.requested.has(id))', replace: '', fails: ['mixin: a read of the bodies made for other IDs'] },
  { name: 'a read of the bodies for another save is used', target: MIXIN, find: 'bundle && bundle.database === this.database && bundle.GameID === this.GameID && bundle.RaceID === this.RaceID && ', replace: 'bundle && ', fails: ['mixin: a read of the bodies made for other IDs'] },
  { name: 'a failed read of the bodies is taken for no bodies', target: MIXIN, find: 'bodies: null, error: error && error.message', replace: 'bodies: new Map(), error: error && error.message', fails: ['mixin: a read of the bodies that failed'] },
  { name: 'a form is saved for the scope it was not filled in for', target: MIXIN, find: 'if (scopeKey !== undefined && scopeKey !== this.tagScopeKey) {', replace: 'if (false) {', fails: ['mixin: a form filled in for another'] },
  { name: 'the picker offers the bodies of no system the host picked', target: MIXIN, find: 'bundle && bundle.bodies && Number.isInteger(this.tagSystemId) ? tagChoices(bundle.bodies, this.tagSystemId) : []', replace: 'bundle && bundle.bodies ? tagChoices(bundle.bodies, 1) : []', fails: ['mixin: only the bodies of the picked system'] },
  { name: 'keeping a tag changes the clusters of the map', target: MIXIN, find: "      return this.tagRun(scopeKey, () => saveTag(this.tagRepository, this.tagScope, { tag, target: { type: 'body', row }, expected, context: this.tagContext }), 'The tag is kept.')", replace: "      this.groups = []\n\n      return this.tagRun(scopeKey, () => saveTag(this.tagRepository, this.tagScope, { tag, target: { type: 'body', row }, expected, context: this.tagContext }), 'The tag is kept.')", fails: ['map: tagging, changing and clearing'] },
  { name: 'a stale reason is the same for a body that is gone and one that is another', target: 'component', find: "entry.link && entry.link.status === 'missing' ? 'is no longer in this save'", replace: "true ? 'is no longer in this save'", fails: ['component: a stale tag says why'] },
  { name: 'a save from before the tag is told for a tag that matches', target: 'component', find: "rewound: entry.ahead && entry.link && entry.link.status !== 'linked' ?", replace: 'rewound: entry.ahead ?', fails: ['component: a save from before the tag was made'] },
  { name: 'a save from before the tag is never told', target: 'component', find: 'rewound: entry.ahead &&', replace: 'rewound: false &&', fails: ['component: a save from before the tag was made'] },
  { name: 'the form is kept when what is shown changes', target: 'component', find: 'scopeKey() {\n      this.pick = null', replace: 'scopeKey() {\n      this.pick = this.pick', fails: ['component: the form is dropped'] },
  { name: 'a change is saved over the latest revision of the tag', target: 'component', find: 'this.editing === row.uuid && this.editEntry && await this.retag({ entry: this.editEntry,', replace: 'this.editing === row.uuid && await this.retag({ entry: this.entries.find((entry) => entry.uuid === row.uuid),', fails: ['component: a change of a tag saved after'] },
  { name: 'a clear is made over the latest revision of the tag', target: 'component', find: 'await this.clear(this.confirmEntry)', replace: 'await this.clear(this.entries.find((entry) => entry.uuid === row.uuid))', fails: ['component: a clear of a tag confirmed after'] },
  { name: 'the top form takes the tag of the body when it saves, not when the body was picked', target: 'component', find: 'const expected = this.expected && this.expected.id === this.pick.id ? this.expected.value : null', replace: 'const expected = this.expect(this.pick.row)', fails: ['component: the top form of the Notebook with the body tagged', 'component: the top form of the Notebook with the body untagged', "component: the top form of the Galaxy Map's side panel with the body tagged", "component: the top form of the Galaxy Map's side panel with the body untagged"] },
  { name: 'the tag a body had is read from the tags a filter shows', target: MIXIN, find: 'return expectedOf(this.tagEntries, row)', replace: 'return expectedOf(this.tagShown, row)', fails: ['component: the top form of the Notebook with the body tagged'] },
  { name: 'a form saves without what the body had', target: MIXIN, find: 'target: { type: \'body\', row }, expected, context', replace: 'target: { type: \'body\', row }, context', fails: ['component: the top form of the Notebook with the body tagged', "component: the top form of the Galaxy Map's side panel with the body untagged"] },
  { name: 'a save that is a conflict drops the draft of the form', target: 'component', find: 'if (await this.save({ row: this.pick.row, tag: this.text, expected, scopeKey: this.filledFor === null ? this.scopeKey : this.filledFor })) {', replace: "if (await this.save({ row: this.pick.row, tag: this.text, expected, scopeKey: this.filledFor === null ? this.scopeKey : this.filledFor }) !== 'never') {", fails: ['component: the top form of the Notebook with the body tagged when another window', 'component: the top form of the Notebook with the body untagged when another window', 'component: the top form of the Notebook with the body tagged when it was picked'] },
  { name: 'a body that is no longer offered stays picked', target: 'component', find: 'if (this.pick && !choices.some((choice) => choice.id === this.pick.id)) {', replace: 'if (false) {', fails: ['component: the form is dropped'] },
  { name: 'the map never says a system holds only stale tags', target: 'map', find: "names.push(this.tagSystems[row.id].stale ? 'tags-stale' : 'tags')", replace: "names.push('tags')", fails: ['map: a system with a tagged body'] },
  { name: 'the map marks the systems the filter lets out', target: 'map', find: "if (marks.has('tags') && this.tagSystems[row.id]) {", replace: "if (marks.has('tags') && this.tagAllSystems[row.id]) {", fails: ['map: the tag filter marks'] },
  { name: 'the map marks a system with no mark on', target: 'map', find: "if (marks.has('tags') && this.tagSystems[row.id]) {", replace: 'if (this.tagSystems[row.id]) {', fails: ['map: a system with a tagged body'] },
  { name: 'the map does not fade the systems the filter lets out', target: 'map', find: '(this.tagFilterValue !== ALL_TAGS && !this.tagSystems[row.id]) || ', replace: '', fails: ['map: the tag filter marks'] },
  { name: 'choosing a tag does not turn the mark on', target: 'map', find: "if (value !== ALL_TAGS && !this.marksSet.has('tags')) {", replace: 'if (false) {', fails: ['map: choosing a tag turns the mark'] },
  { name: 'choosing all tags turns the mark on', target: 'map', find: "if (value !== ALL_TAGS && !this.marksSet.has('tags')) {", replace: "if (!this.marksSet.has('tags')) {", fails: ['map: choosing a tag turns the mark'] },
  { name: 'the panel lists the tags of every system', target: 'map', find: 'return there ? there.entries : []', replace: 'return this.tagEntries', fails: ['map: the side panel lists the tags'] },
  { name: 'the panel offers the bodies of no system', target: 'map', find: 'return this.panelSystem ? this.panelSystem.SystemID : null', replace: 'return null', fails: ['map: the side panel lists the tags'] },
]

const mutatedCopy = ({ file, find, replace }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-world-tags-mutant-'))

  fs.cpSync(utilitiesDirectory, directory, { recursive: true })

  const target = path.join(directory, file)
  const source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')

  try {
    fs.writeFileSync(target, patched(file, source, unhashed(find), unhashed(replace)))
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true })
    throw error
  }

  return directory
}

const loadModules = async (directory) => {
  const loaded = await loadUtilities(NAMES, { stubs: STUBS, directory })
  const wiring = await loadUtilities(['main/store-host', 'preload/store-client'], { directory: path.join(root, 'src') })

  return { tags: loaded['world-tags'], notes: loaded['economy-notes'], milestones: loaded['history-milestones'], records: loaded['scenario-records'], backup: loaded['history-backup'], host: wiring['main/store-host'], client: wiring['preload/store-client'] }
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
const MUTANTS = [...UTILITY_MUTATIONS.map((mutant) => ({ mutant, page: false })), ...PAGE_MUTATIONS.map((mutant) => ({ mutant, page: true }))]

// What the baseline, each mutant and the control print, as entries a child hands to the parent: a line of text, or the arguments of `show`.
const baselineEntries = async () => {
  const modules = await loadModules(utilitiesDirectory)
  const entries = [{ log: 'The tags: the moon rule, the known bodies, edits, stale tags, rewinds, isolation, the filter, scope, reads, backup and the owner\'s saves' }]

  for (const [name, result, detail, skip] of await runChecks(suite(modules))) {
    entries.push({ show: [name, result, detail, skip] })
  }

  entries.push({ log: '\nThe Notebook and the Galaxy Map (the shared mixin, the component and the map over scripts/lib/page-loader.js)' })

  for (const [name, result] of await runChecks(await pageSuite(modules))) {
    entries.push({ show: [name, result] })
  }

  return entries
}

const mutantEntries = async ({ mutant, page }) => {
  let directory = null

  try {
    let results = null

    if (page) {
      results = await runChecks(await pageSuite(await loadModules(utilitiesDirectory), mutant), mutant.fails)
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
  const modules = await loadModules(utilitiesDirectory)
  const control = await runChecks(suite(modules), [...new Set(UTILITY_MUTATIONS.flatMap((mutant) => mutant.fails))])
  const controlPage = await runChecks(await pageSuite(modules), [...new Set(PAGE_MUTATIONS.flatMap((mutant) => mutant.fails))])
  const wrong = [...control, ...controlPage].filter(([, result]) => result !== true).map(([name]) => name)

  return [{ show: ['a control run of the unchanged code passes every check the mutants name', wrong.length === 0 ? true : `fails ${wrong.join('; ')}`] }]
}

// A child runs the baseline (`--baseline`), the control (`--control`) or some mutants in turn (`--mutants=<i>,<i>`) in a process of its own, so no chunk shares the modules or the stores of another, and prints its entries as JSON on its last line.
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
