/*
  Checks the campaign-local repository of the planners' typed records (utilities/scenario-records.js): which records a campaign, race and branch sees, what happens to a record when a save is reloaded or rewound, how edits of two windows meet, how the file is versioned and what an import may do.

  node scripts/check-scenario-records.js [--no-mutations]

  Everything runs on in-memory stores (each a JSON value read and written whole, with the store client's compare-and-swap `update`), on the real store host and client of the app (src/main/store-host.js, src/preload/store-client.js) for the two-window cases and the wiring, and on web mode's store shim over a fake `localStorage`. No Electron, no save and no network are needed; nothing is written outside the process.

  Groups:
  - identity: two adapters keep records with equal local object IDs apart across campaigns and races; a record is never found for another race or campaign; a file kept under another campaign's name is refused; a branch-policy record shows only on its branch; a rewound save flags a record made later as ahead;
  - links: an object that is gone is missing, an ID reused by another object is changed, neither is ever rebound (by ID, by fingerprint or by a reload or rewind), and a link that cannot be resolved is unknown;
  - edits: a stale edit is rejected with the stored record and an explicit reconcile works; two windows over one host keep both writes and never overwrite one another's edit; a create's precondition runs inside the write, again over what another window wrote; a clone has a new uuid and its source's provenance; a delete names the revision; only the editable fields change;
  - versions: a version-0 file is migrated with every payload and provenance exactly as it was, a newer or damaged file is refused and left untouched, an older adapter schema is migrated for the view and on an edit, an unknown kind or a newer schema is kept and not edited;
  - adapters: the adapter's refusal of a payload is the repository's, a payload that is not JSON is refused, registrations are checked, only the campaign's own file is written;
  - import: an export carries provenance, an import needs an explicit target and the preview of the same bundle and target, takes a new uuid, the target's campaign, race and branch, never rebinds a link and never takes a record its adapter rejects;
  - wiring: the app's factory opens one file per campaign through the store client and host, and through web mode's shim.

  Mutants: each of a list of deliberate faults in a copy of the repository module is run, with the checks it names, in a Node process of its own on a copied tree; it is caught when each named check fails there. A control run of the unchanged copy must pass every check the mutants name. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { inParallel } = require('./lib/check-pool')

const repo = path.resolve(__dirname, '..')
const src = path.join(repo, 'src')
const MODULE = 'renderer/utilities/scenario-records'
const RESULT_PREFIX = 'SCENARIO-RESULT '

const STUBS = { 'electron-store': 'export default class { constructor (options) { return new globalThis.__scenarioStore(options) } }' }

const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const omit = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key))

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// A campaign of the registry as the campaign module writes it, complete enough for its own reader to accept; `mergedInto` marks it as attached to another.
const campaignEntry = (campaignId, mergedInto) => ({ id: campaignId, names: [], gameIds: [], anchor: [], attachments: [], branches: { b1: { id: 'b1', tip: { n: 0, digest: '0', checkpoints: [] } } }, branchSeq: 1, ...(mergedInto ? { mergedInto } : {}) })

const loadModules = async (base) => {
  const loaded = await loadUtilities([MODULE, 'main/store-host', 'preload/store-client'], { stubs: STUBS, directory: base })
  const shim = await loadUtilities(['../scripts/web/shims/electron-store'], { directory: base })

  return { records: loaded[MODULE], host: loaded['main/store-host'], client: loaded['preload/store-client'], Shim: shim['../scripts/web/shims/electron-store'].default }
}

// ---- Fixtures --------------------------------------------------------------------------------------------------------

const thrown = (work) => {
  try {
    work()
  } catch (error) {
    return error
  }

  return null
}

const refusal = (work, code) => {
  const error = thrown(work)

  assert.ok(error, `it should have been refused with ${code}`)
  assert.equal(error.name, 'RecordsRefused', error.stack)
  assert.equal(error.code, code, error.message)

  return error
}

const conflictOf = (work) => {
  const error = thrown(work)

  assert.ok(error, 'it should have been rejected as stale')
  assert.equal(error.name, 'RevisionConflict', error.stack)
  assert.equal(error.code, 'revision-conflict')

  return error
}

// The stores of one installation: each a JSON value read and written whole, as electron-store's `.store` is, with the store client's whole-file `update` (a change made again over what is stored when another write came between).
const memory = () => {
  const files = new Map()
  const writes = []
  const registry = { value: {} }
  const store = (name) => ({
    get store () {
      return copy(files.get(name)) || {}
    },
    set store (value) {
      files.set(name, copy(value))
      writes.push(name)
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

  return { files, writes, registry, storage: { open: (campaignId) => store(`campaign-${campaignId}`), registry: () => copy(registry.value) }, snapshot: () => JSON.stringify([...files].sort(([a], [b]) => (a < b ? -1 : 1))) }
}

const classRow = (name, size) => ({ name, size })

// Two planners' adapters: a design scenario (payload schema 2, migrated from schema 1's { name, tech }) and a colony note, both with typed links whose fingerprints name the object they point at.
const adapters = (m) => {
  const registry = m.records.createAdapterRegistry()
  const rowOf = (context, link) => (context.rows && context.rows[link.type] && context.rows[link.type][link.id]) || null

  registry.register({
    kind: 'design-scenario',
    schema: 2,
    validate: (payload) => (typeof payload.title === 'string' && Array.isArray(payload.techIds) ? [] : ['a design scenario has a title and a list of techIds']),
    migrate: (payload, from) => {
      if (from === 1) {
        return { title: payload.name, techIds: payload.tech }
      }

      throw new Error(`no migration from schema ${from}`)
    },
    fingerprint: (type, row) => [type, row.name, row.size].join(':'),
    resolve: (links, context) => links.map((link) => rowOf(context, link)),
    versions: (payload) => ({ 'design.rules': '2.7.x', techCount: payload.techIds.length }),
  })
  registry.register({
    kind: 'colony-note',
    schema: 1,
    validate: (payload) => (typeof payload.text === 'string' ? true : 'a colony note has text'),
    fingerprint: (type, row) => [type, row.name, row.size].join(':'),
    resolve: (links, context) => {
      if (context.mode === 'throw') {
        throw new Error('the save could not be read')
      }

      return context.mode === 'short' ? [] : links.map((link) => rowOf(context, link))
    },
    versions: { 'notes.rules': '1' },
  })

  return registry
}

const world = (m) => {
  const inst = memory()
  const registry = adapters(m)
  let clock = 1000
  const make = (extra = {}) => m.records.createRepository({ storage: inst.storage, adapters: registry, now: () => ++clock, ...extra })

  return { inst, registry, make, repo: make() }
}

const scope = (campaignId = 'c1', RaceID = 7, branchId = 'b1', gameTime = 1000) => ({ campaignId, RaceID, branchId, gameTime })

const design = (repository, where, extra = {}) => repository.create(where, { kind: 'design-scenario', payload: { title: 'Corvette', techIds: [3, 4] }, links: [{ type: 'ship-class', id: 5, row: classRow('Corvette', 10) }], assumptions: [{ key: 'tech', text: 'researched only' }], ...extra })

const note = (repository, where, extra = {}) => repository.create(where, { kind: 'colony-note', payload: { text: 'mine more' }, links: [{ type: 'colony', id: 5, row: classRow('Earth', 1) }], ...extra })

const rows = (type, id, row) => ({ rows: { [type]: row ? { [id]: row } : {} } })

// A store client and host pair over in-memory files, as check-campaigns does: `client(hook)` is a window whose requests call `hook(request)` before the host answers.
const hosted = (m) => {
  const files = new Map()
  const host = m.host.createStoreHost((options) => {
    const key = `${options.cwd || ''}/${options.name || 'config'}`

    return {
      get store () {
        return copy(files.get(key)) || {}
      },
      set store (value) {
        files.set(key, copy(value))
      },
      get path () {
        return key
      },
    }
  })
  const client = (hook = null) => m.client.createStoreClient((request) => {
    if (hook) {
      hook(request)
    }

    return host.handle(request)
  })

  return { files, host, client }
}

const overClient = (m, Remote, registry, extra = {}) => m.records.createRepository({ storage: { open: (campaignId) => new Remote({ cwd: 'scenarios', name: m.records.scenarioFileName(campaignId) }) }, adapters: registry, ...extra })

// What a version-0 file holds: the earliest shape, a list of records pinned to the branch they were made on.
const version0 = () => ({
  version: 0,
  records: [
    { uuid: id(1), kind: 'design-scenario', schema: 1, payload: { name: 'Old', tech: [1, 2], nested: { a: [1, { b: null }], z: 'ü', n: 1.5 } }, campaignId: 'c1', RaceID: 7, branchId: 'b1', gameTime: 500, createdAt: 111, updatedAt: 222, provenance: { via: 'created', note: 'first' } },
    { uuid: id(2), kind: 'colony-note', schema: 1, payload: { text: 'hi' }, campaignId: 'c1', RaceID: 7, branchId: 'b2', gameTime: 900, createdAt: 333, updatedAt: 333, provenance: { via: 'created' } },
  ],
})

const fakeLocalStorage = () => {
  const items = new Map()

  return { items, getItem: (key) => (items.has(key) ? items.get(key) : null), setItem: (key, value) => { items.set(key, String(value)) }, removeItem: (key) => { items.delete(key) } }
}

// The browser's Web Locks as far as the storage uses them: one holder at a time per name, the others queued in order, a lock released when the callback's promise settles.
const fakeLocks = () => {
  const names = new Map()

  return {
    request: (name, callback) => new Promise((resolve, reject) => {
      const lock = names.get(name) || { held: false, queue: [] }

      names.set(name, lock)

      const grant = () => {
        lock.held = true
        Promise.resolve().then(callback).then(resolve, reject).then(() => {
          lock.held = false

          const next = lock.queue.shift()

          if (next) {
            next()
          }
        })
      }

      if (lock.held) {
        lock.queue.push(grant)
      } else {
        grant()
      }
    }),
  }
}

// ---- The suite -------------------------------------------------------------------------------------------------------

const defineSuite = (m) => {
  const checks = []
  const check = (group, name, run) => checks.push({ group, name, run })

  // ---- identity ----------------------------------------------------------------------------------------------------

  check('identity', 'two adapters keep records with equal local object IDs in two campaigns and two races apart', () => {
    const w = world(m)
    const scopes = [scope('c1', 7), scope('c1', 8), scope('c2', 7), scope('c2', 8)]
    const made = scopes.map((where, index) => [design(w.repo, where, { payload: { title: `D${index}`, techIds: [index] } }), note(w.repo, where, { payload: { text: `N${index}` } })])

    scopes.forEach((where, index) => {
      const listed = w.repo.list(where)

      assert.deepEqual(listed.map((entry) => entry.record.uuid).sort(), made[index].map((record) => record.uuid).sort())
      listed.forEach((entry) => {
        assert.equal(entry.record.campaignId, where.campaignId)
        assert.equal(entry.record.RaceID, where.RaceID)
        assert.equal(entry.links[0].id, 5)
      })
      assert.deepEqual(listed.map((entry) => entry.record.kind).sort(), ['colony-note', 'design-scenario'])
    })

    assert.equal(new Set(made.flat().map((record) => record.uuid)).size, 8)
    assert.deepEqual([...w.inst.files.keys()].sort(), ['campaign-c1', 'campaign-c2'])
    assert.equal(Object.keys(w.inst.files.get('campaign-c1').records).length, 4)
  })

  check('identity', 'a record is never found for another race or campaign', () => {
    const w = world(m)
    const made = design(w.repo, scope('c1', 7))
    const before = w.inst.snapshot()
    const writes = w.inst.writes.length

    ;[scope('c1', 8), scope('c2', 7)].forEach((other) => {
      assert.deepEqual(w.repo.list(other), [])
      assert.equal(w.repo.read(other, made.uuid), null)
      refusal(() => w.repo.update(other, made.uuid, 1, { assumptions: [] }), 'not-found')
      refusal(() => w.repo.delete(other, made.uuid, 1), 'not-found')
      refusal(() => w.repo.clone(other, made.uuid), 'not-found')
      refusal(() => w.repo.exportRecords(other, { uuids: [made.uuid] }), 'not-found')
      assert.deepEqual(w.repo.exportRecords(other).records, [])
    })

    assert.equal(w.inst.snapshot(), before)
    assert.equal(w.inst.writes.length, writes)
    assert.equal(w.inst.files.has('campaign-c2'), false)
  })

  check('identity', 'a file kept under another campaign\'s name is refused and left as it is', () => {
    const w = world(m)

    design(w.repo, scope('c1', 7))
    w.inst.files.set('campaign-c2', copy(w.inst.files.get('campaign-c1')))

    const before = w.inst.snapshot()
    const writes = w.inst.writes.length

    refusal(() => w.repo.list(scope('c2', 7)), 'damaged')
    refusal(() => design(w.repo, scope('c2', 7)), 'damaged')
    assert.equal(w.inst.snapshot(), before)
    assert.equal(w.inst.writes.length, writes)
  })

  check('identity', 'a branch-policy record shows only on its branch and a campaign-policy record on every branch', () => {
    const w = world(m)
    const onBranch = design(w.repo, scope('c1', 7, 'b1'), { policy: 'branch' })
    const everywhere = note(w.repo, scope('c1', 7, 'b1'), { policy: 'campaign' })
    const b2 = scope('c1', 7, 'b2')

    assert.deepEqual(w.repo.list(scope('c1', 7, 'b1')).map((entry) => entry.record.uuid).sort(), [onBranch.uuid, everywhere.uuid].sort())
    assert.deepEqual(w.repo.list(b2).map((entry) => entry.record.uuid), [everywhere.uuid])
    assert.equal(w.repo.read(b2, onBranch.uuid), null)
    assert.notEqual(w.repo.read(b2, everywhere.uuid), null)
    refusal(() => w.repo.update(b2, onBranch.uuid, 1, { assumptions: [] }), 'not-found')
    refusal(() => w.repo.delete(b2, onBranch.uuid, 1), 'not-found')
    refusal(() => w.repo.clone(b2, onBranch.uuid), 'not-found')
    assert.deepEqual(w.repo.exportRecords(b2).records.map((record) => record.uuid), [everywhere.uuid])

    const pinned = w.repo.update(b2, everywhere.uuid, 1, { policy: 'branch' })

    assert.equal(pinned.association.branchId, 'b2')
    assert.equal(w.repo.read(scope('c1', 7, 'b1'), everywhere.uuid), null)
  })

  check('identity', 'a record made later than the open save is flagged ahead on a rewind and a fork, never applied as current', () => {
    const w = world(m)
    const made = design(w.repo, scope('c1', 7, 'b1', 1000))
    const at = (time, branch = 'b1', options = {}) => w.repo.list(scope('c1', 7, branch, time), options)

    assert.equal(at(1000)[0].status, 'current')
    assert.equal(at(1500)[0].status, 'current')
    assert.deepEqual(at(1000)[0].flags, [])

    const rewound = at(400)[0]
    const before = w.inst.snapshot()

    assert.equal(rewound.status, 'ahead')
    assert.ok(rewound.flags.includes('ahead'))
    assert.deepEqual(at(400, 'b1', { status: 'current' }), [])
    assert.equal(w.repo.read(scope('c1', 7, 'b1', 400), made.uuid).status, 'ahead')

    const forked = at(400, 'b2')[0]

    assert.equal(forked.status, 'ahead')
    assert.ok(forked.flags.includes('ahead') && forked.flags.includes('other-branch'))
    assert.deepEqual(at(1200, 'b2')[0].flags, ['other-branch'])
    assert.equal(w.inst.snapshot(), before)
    assert.equal(w.repo.read(scope('c1', 7, 'b1', 1500), made.uuid).record.base.gameTime, 1000)
  })

  check('identity', 'a reload over the persisted JSON returns the same records and never moves one to another race or campaign', () => {
    const w = world(m)
    const mine = [design(w.repo, scope('c1', 7)), note(w.repo, scope('c1', 7))]

    design(w.repo, scope('c2', 7))

    const reloaded = w.make()
    const writes = w.inst.writes.length

    assert.deepEqual(reloaded.list(scope('c1', 7)).map((entry) => entry.record), w.repo.list(scope('c1', 7)).map((entry) => entry.record))
    assert.deepEqual(reloaded.list(scope('c1', 7)).map((entry) => entry.record.uuid).sort(), mine.map((record) => record.uuid).sort())
    assert.deepEqual(reloaded.list(scope('c1', 8)), [])
    assert.equal(reloaded.list(scope('c2', 7)).length, 1)
    assert.ok(reloaded.list(scope('c2', 7)).every((entry) => !mine.some((record) => record.uuid === entry.record.uuid)))
    assert.equal(w.inst.writes.length, writes)
  })

  check('identity', 'an unsafe campaign id or an incomplete scope is refused before anything is read or written', () => {
    const w = world(m)

    refusal(() => m.records.scenarioFileName('../x'), 'invalid-scope')
    refusal(() => m.records.scenarioFileName('a/b'), 'invalid-scope')
    refusal(() => w.repo.list(scope('../x', 7)), 'invalid-scope')
    refusal(() => w.repo.list({ ...scope(), RaceID: '7' }), 'invalid-scope')
    refusal(() => w.repo.list({ ...scope(), gameTime: undefined }), 'invalid-scope')
    refusal(() => w.repo.list({ campaignId: 'c1', RaceID: 7 }), 'invalid-scope')
    refusal(() => w.repo.list(null), 'invalid-scope')
    assert.equal(w.inst.writes.length, 0)
  })

  check('identity', 'records of a campaign attached to the open one are listed apart and flagged, never mixed in, and adopted only by an explicit step that leaves the source untouched', () => {
    const w = world(m)
    const registry = { campaigns: { c1: campaignEntry('c1'), s1: campaignEntry('s1', { campaignId: 'c1', branchId: 'b1', at: 5 }), s2: campaignEntry('s2', { campaignId: 's1', branchId: 'b1', at: 6 }), s3: campaignEntry('s3'), loop1: campaignEntry('loop1', { campaignId: 'loop2' }), loop2: campaignEntry('loop2', { campaignId: 'loop1' }) } }

    w.inst.registry.value = registry

    const where = scope('c1', 7, 'b1', 1000)
    const own = design(w.repo, where)
    const fromS1 = note(w.repo, scope('s1', 7))
    const otherRace = design(w.repo, scope('s1', 8))
    const fromS2 = design(w.repo, scope('s2', 7, 'b4'), { policy: 'branch' })
    const unattached = note(w.repo, scope('s3', 7))
    const looped = note(w.repo, scope('loop1', 7))
    const uuidsOf = (entries) => entries.map((entry) => entry.record.uuid).sort()
    const before = w.inst.snapshot()
    const found = w.repo.listAttached(where)

    assert.deepEqual(uuidsOf(w.repo.list(where)), [own.uuid])
    assert.deepEqual(w.repo.exportRecords(where).records.map((record) => record.uuid), [own.uuid])
    assert.equal(w.repo.read(where, fromS1.uuid), null)
    assert.deepEqual(found.refused, [])
    assert.deepEqual(uuidsOf(found.entries), [fromS1.uuid, fromS2.uuid].sort())
    assert.deepEqual(found.entries.map((entry) => entry.attachedFrom).sort(), ['s1', 's2'])
    found.entries.forEach((entry) => {
      assert.ok(entry.flags.includes('attached-campaign'))
      assert.equal(entry.record.campaignId, entry.attachedFrom)
      assert.equal(entry.record.RaceID, 7)
    })
    assert.deepEqual(uuidsOf(w.repo.listAttached(where, { kind: 'colony-note' }).entries), [fromS1.uuid])
    assert.deepEqual(uuidsOf(w.repo.listAttached(scope('c1', 8)).entries), [otherRace.uuid])
    assert.deepEqual(w.repo.listAttached(scope('c1', 7, 'b1', 1), { status: 'current' }).entries, [])
    assert.equal(w.repo.listAttached(where, { context: rows('ship-class', 5, null) }).entries.find((entry) => entry.record.uuid === fromS2.uuid).links[0].status, 'missing')
    assert.equal(w.inst.snapshot(), before)

    const sourceBefore = JSON.stringify(w.inst.files.get('campaign-s1'))
    const adopted = w.repo.adopt(where, 's1', fromS1.uuid)

    assert.notEqual(adopted.uuid, fromS1.uuid)
    assert.equal(adopted.revision, 1)
    assert.equal(adopted.campaignId, 'c1')
    assert.equal(adopted.RaceID, 7)
    assert.deepEqual(adopted.association, { policy: 'campaign', branchId: 'b1' })
    assert.deepEqual(adopted.payload, fromS1.payload)
    assert.deepEqual(adopted.links, fromS1.links)
    assert.equal(adopted.provenance.via, 'adopt')
    assert.equal(adopted.provenance.from.campaignId, 's1')
    assert.equal(adopted.provenance.from.uuid, fromS1.uuid)
    assert.equal(JSON.stringify(w.inst.files.get('campaign-s1')), sourceBefore)
    assert.deepEqual(uuidsOf(w.repo.list(where)), [own.uuid, adopted.uuid].sort())
    assert.equal(w.repo.listAttached(where).entries.length, 2)
    refusal(() => w.repo.adopt(where, 's1', fromS1.uuid), 'collision')

    // a record pinned to a branch of a campaign attached through a chain is pinned to the branch that adopts it
    const onB2 = w.repo.adopt(scope('c1', 7, 'b2', 1000), 's2', fromS2.uuid)

    assert.deepEqual(onB2.association, { policy: 'branch', branchId: 'b2' })
    assert.equal(onB2.provenance.from.association.branchId, 'b4')
    assert.equal(w.repo.read(where, onB2.uuid), null)

    ;[['s3', unattached.uuid], ['loop1', looped.uuid], ['c1', own.uuid], ['nope', fromS1.uuid], ['s2', fromS1.uuid], ['s1', otherRace.uuid], ['s1', '__proto__'], ['s1', undefined]].forEach(([source, uuid]) => {
      refusal(() => w.repo.adopt(where, source, uuid), 'not-found')
    })
    refusal(() => w.repo.adopt(scope('c1', 8), 's1', fromS1.uuid), 'not-found')
    assert.equal(JSON.stringify(w.inst.files.get('campaign-s1')), sourceBefore)

    // a registry that is not what the campaign module writes is refused, never read as no attachments
    const frozen = w.inst.snapshot()

    ;['garbage', { campaigns: 'x' }, { campaigns: { s1: 'text' } }, { ...registry, version: 99 }, { ...registry, version: 'one' }, { ...registry, campaigns: { ...registry.campaigns, s1: omit(registry.campaigns.s1, 'branches') } }, { campaigns: { s1: campaignEntry('s1', { campaignId: '../x' }) } }].forEach((broken) => {
      w.inst.registry.value = broken
      refusal(() => w.repo.listAttached(where), 'registry-unreadable')
      refusal(() => w.repo.adopt(where, 's1', fromS1.uuid), 'registry-unreadable')
      assert.equal(w.repo.list(where).length, 2)
      assert.equal(w.inst.snapshot(), frozen)
    })

    // a source file that cannot be read is reported, not skipped
    w.inst.registry.value = registry
    w.inst.files.set('campaign-s2', 'garbage')

    const partial = w.repo.listAttached(where)

    assert.deepEqual(uuidsOf(partial.entries), [fromS1.uuid])
    assert.deepEqual(partial.refused.map((entry) => [entry.campaignId, entry.code]), [['s2', 'damaged']])
    assert.equal(w.inst.files.get('campaign-s2'), 'garbage')

    // a repository over storage with no registry knows no attachments
    assert.deepEqual(m.records.createRepository({ storage: { open: w.inst.storage.open }, adapters: w.registry }).listAttached(where), { entries: [], refused: [] })
  })

  // ---- links -------------------------------------------------------------------------------------------------------

  check('links', 'a link whose object is gone stays inspectable as missing and is never rebound', () => {
    const w = world(m)
    const where = scope('c1', 7)
    const made = design(w.repo, where)
    const before = w.inst.snapshot()
    const linked = w.repo.read(where, made.uuid, { context: rows('ship-class', 5, classRow('Corvette', 10)) })

    assert.equal(linked.links[0].status, 'linked')
    assert.equal(linked.unresolved, 0)

    const gone = w.repo.read(where, made.uuid, { context: rows('ship-class', 5, null) })

    assert.equal(gone.links[0].status, 'missing')
    assert.equal(gone.links[0].id, 5)
    assert.equal(gone.links[0].fingerprint, 'ship-class:Corvette:10')
    assert.equal(gone.unresolved, 1)
    assert.ok(gone.flags.includes('missing-link'))
    assert.deepEqual(gone.record, made)
    assert.deepEqual(gone.payload, { title: 'Corvette', techIds: [3, 4] })

    // another object that happens to have the same fingerprint, under another id, is not the linked object
    const lookalike = w.repo.list(where, { context: rows('ship-class', 6, classRow('Corvette', 10)) })[0]

    assert.equal(lookalike.links[0].status, 'missing')
    assert.equal(lookalike.links[0].id, 5)
    assert.equal(w.inst.snapshot(), before)
  })

  check('links', 'an object ID reused by a different object is changed and is never rebound', () => {
    const w = world(m)
    const where = scope('c1', 7)
    const made = design(w.repo, where)
    const before = w.inst.snapshot()
    const reused = w.repo.read(where, made.uuid, { context: rows('ship-class', 5, classRow('Frigate', 20)) })

    assert.equal(reused.links[0].status, 'changed')
    assert.equal(reused.links[0].current, 'ship-class:Frigate:20')
    assert.equal(reused.links[0].fingerprint, 'ship-class:Corvette:10')
    assert.equal(reused.unresolved, 1)
    assert.ok(reused.flags.includes('changed-link'))
    assert.equal(w.make().read(where, made.uuid, { context: rows('ship-class', 5, classRow('Corvette', 11)) }).links[0].status, 'changed')
    assert.equal(w.inst.snapshot(), before)

    const stored = w.inst.files.get('campaign-c1').records[made.uuid]

    assert.deepEqual(stored.links, [{ type: 'ship-class', id: 5, fingerprint: 'ship-class:Corvette:10' }])
    assert.equal(stored.revision, 1)
  })

  check('links', 'a reload and a rewind that keep the same object keep the link linked and the record where it was', () => {
    const w = world(m)
    const made = design(w.repo, scope('c1', 7, 'b1', 1000))
    const same = rows('ship-class', 5, classRow('Corvette', 10))
    const rewound = w.make().read(scope('c1', 7, 'b1', 300), made.uuid, { context: same })

    assert.equal(rewound.links[0].status, 'linked')
    assert.equal(rewound.status, 'ahead')
    assert.equal(w.make().read(scope('c1', 8, 'b1', 1000), made.uuid, { context: same }), null)

    // the same rewound save in which the object does not exist yet or is another one
    assert.equal(w.make().read(scope('c1', 7, 'b1', 300), made.uuid, { context: rows('ship-class', 5, null) }).links[0].status, 'missing')
    assert.equal(w.make().read(scope('c1', 7, 'b1', 300), made.uuid, { context: rows('ship-class', 5, classRow('Other', 3)) }).links[0].status, 'changed')
    assert.equal(w.make().read(scope('c1', 7, 'b1', 1000), made.uuid, { context: same }).links[0].status, 'linked')
  })

  check('links', 'a link that cannot be resolved is unknown, never linked and never an error', () => {
    const w = world(m)
    const where = scope('c1', 7)
    const made = note(w.repo, where)
    const same = rows('colony', 5, classRow('Earth', 1))

    assert.equal(w.repo.read(where, made.uuid).links[0].status, 'unknown')
    assert.equal(w.repo.read(where, made.uuid, { context: { ...same, mode: 'throw' } }).links[0].status, 'unknown')
    assert.equal(w.repo.read(where, made.uuid, { context: { ...same, mode: 'short' } }).links[0].status, 'unknown')
    assert.equal(w.repo.read(where, made.uuid, { context: null }).links[0].status, 'unknown')
    assert.equal(w.repo.read(where, made.uuid, { context: null }).unresolved, 0)
    assert.equal(w.repo.list(where, { context: null })[0].links[0].status, 'unknown')
    assert.equal(w.repo.read(where, made.uuid, { context: same }).links[0].status, 'linked')
    assert.equal(w.repo.read(where, made.uuid, { context: { ...same, mode: 'throw' } }).unresolved, 0)
    assert.equal(design(w.repo, where, { links: [] }).links.length, 0)
    assert.deepEqual(w.repo.list(where, { kind: 'design-scenario' }).map((entry) => entry.links), [[]])
  })

  check('links', 'a link is replaced only by an explicit edit, which then resolves against the object now there', () => {
    const w = world(m)
    const where = scope('c1', 7)
    const made = design(w.repo, where)
    const context = rows('ship-class', 5, classRow('Frigate', 20))

    assert.equal(w.repo.read(where, made.uuid, { context }).links[0].status, 'changed')

    const relinked = w.repo.update(where, made.uuid, 1, { links: [{ type: 'ship-class', id: 5, row: classRow('Frigate', 20) }] })

    assert.equal(relinked.revision, 2)
    assert.equal(w.repo.read(where, made.uuid, { context }).links[0].status, 'linked')
    refusal(() => w.repo.update(where, made.uuid, 2, { links: [{ type: 'ship-class', id: 5 }] }), 'invalid-record')
    refusal(() => w.repo.update(where, made.uuid, 2, { links: [{ type: 'ship-class', id: 5, fingerprint: 'a' }, { type: 'ship-class', id: 5, fingerprint: 'b' }] }), 'invalid-record')
  })

  // ---- edits -------------------------------------------------------------------------------------------------------

  check('edits', 'a stale edit is rejected with the stored record and nothing is overwritten', () => {
    const w = world(m)
    const where = scope('c1', 7)
    const made = design(w.repo, where)
    const winner = w.repo.update(where, made.uuid, 1, { payload: { title: 'Winner', techIds: [1] } })
    const before = w.inst.snapshot()
    const error = conflictOf(() => w.repo.update(where, made.uuid, 1, { payload: { title: 'Loser', techIds: [2] } }))

    assert.equal(winner.revision, 2)
    assert.deepEqual(error.stored, winner)
    assert.equal(error.expectedRevision, 1)
    assert.equal(w.inst.snapshot(), before)
    assert.equal(w.repo.read(where, made.uuid).payload.title, 'Winner')
    conflictOf(() => w.repo.update(where, made.uuid, 3, { assumptions: [] }))
    refusal(() => w.repo.update(where, made.uuid, undefined, { assumptions: [] }), 'invalid-record')
    refusal(() => w.repo.update(where, 'nope', 1, { assumptions: [] }), 'not-found')
  })

  check('edits', 'an explicit reconcile applies over exactly the revision the conflict carries and keeps the stale revision', () => {
    const w = world(m)
    const where = scope('c1', 7)
    const made = design(w.repo, where)
    const winner = w.repo.update(where, made.uuid, 1, { assumptions: [{ key: 'other window' }] })
    const error = conflictOf(() => w.repo.update(where, made.uuid, 1, { payload: { title: 'Mine', techIds: [9] } }))
    const merged = w.repo.reconcile(where, error, { payload: { title: 'Mine', techIds: [9] }, assumptions: [...error.stored.assumptions, { key: 'mine' }] })

    assert.equal(merged.revision, 3)
    assert.deepEqual(merged.assumptions, [{ key: 'other window' }, { key: 'mine' }])
    assert.deepEqual(merged.provenance.reconciled.map((entry) => [entry.staleRevision, entry.over]), [[1, 2]])
    assert.equal(merged.createdAt, made.createdAt)
    assert.equal(winner.revision, 2)

    // a reconcile over a record that moved on is a conflict again
    const again = conflictOf(() => w.repo.reconcile(where, error, { assumptions: [] }))

    assert.equal(again.stored.revision, 3)
    assert.equal(w.repo.read(where, made.uuid).record.revision, 3)
    refusal(() => w.repo.reconcile(where, new Error('not a conflict'), { assumptions: [] }), 'invalid-record')
    refusal(() => w.repo.reconcile(scope('c2', 7), error, { assumptions: [] }), 'invalid-record')
  })

  check('edits', 'an edit that another window wrote under is rejected, not overwritten, and can be reconciled (two store clients over one host)', () => {
    const w = world(m)
    const h = hosted(m)
    const where = scope('c1', 7)
    const repoB = overClient(m, h.client(), w.registry)
    let fire = null
    const repoA = overClient(m, h.client((request) => {
      if (fire && (request.op === 'swap' || request.op === 'write')) {
        const run = fire

        fire = null
        run()
      }
    }), w.registry)
    const made = design(repoA, where)

    fire = () => repoB.update(where, made.uuid, 1, { assumptions: [{ key: 'window B' }] })

    const error = conflictOf(() => repoA.update(where, made.uuid, 1, { payload: { title: 'Window A', techIds: [] } }))
    const stored = repoB.read(where, made.uuid).record

    assert.equal(error.stored.revision, 2)
    assert.deepEqual(error.stored.assumptions, [{ key: 'window B' }])
    assert.equal(stored.revision, 2)
    assert.equal(stored.payload.title, 'Corvette')
    assert.deepEqual(stored.assumptions, [{ key: 'window B' }])

    const merged = repoA.reconcile(where, error, { payload: { title: 'Window A', techIds: [] } })

    assert.equal(merged.revision, 3)
    assert.deepEqual(merged.assumptions, [{ key: 'window B' }])
    assert.equal(repoB.read(where, made.uuid).payload.title, 'Window A')
  })

  check('edits', 'two store clients over one host that both write keep both writes', () => {
    const w = world(m)
    const h = hosted(m)
    const where = scope('c1', 7)
    const repoB = overClient(m, h.client(), w.registry)
    let fire = null
    const repoA = overClient(m, h.client((request) => {
      if (fire && (request.op === 'swap' || request.op === 'write')) {
        const run = fire

        fire = null
        run()
      }
    }), w.registry)
    const first = design(repoA, where)
    const second = note(repoA, where)

    // B creates a record between A's read and A's create
    fire = () => note(repoB, where, { payload: { text: 'from B' } })
    design(repoA, where, { payload: { title: 'from A', techIds: [] } })

    let listed = repoA.list(where)

    assert.equal(listed.length, 4)
    assert.deepEqual(listed.map((entry) => entry.payload.title || entry.payload.text).sort(), ['Corvette', 'from A', 'from B', 'mine more'])

    // B edits one record between A's read and A's edit of another
    fire = () => repoB.update(where, second.uuid, 1, { payload: { text: 'B edited' } })
    repoA.update(where, first.uuid, 1, { payload: { title: 'A edited', techIds: [] } })
    listed = repoA.list(where)

    assert.equal(listed.find((entry) => entry.record.uuid === first.uuid).payload.title, 'A edited')
    assert.equal(listed.find((entry) => entry.record.uuid === second.uuid).payload.text, 'B edited')
    assert.equal(listed.length, 4)
    assert.equal(Object.keys(h.files.get('scenarios/campaign-c1').records).length, 4)

    // a delete of a record that another window edited is a conflict
    fire = () => repoB.update(where, first.uuid, 2, { assumptions: [{ key: 'B' }] })
    conflictOf(() => repoA.delete(where, first.uuid, 2))
    assert.equal(repoA.read(where, first.uuid).record.revision, 3)
  })

  check('edits', 'a precondition of a create runs inside the write over the records of its kind, again over what another window wrote, and a throw writes nothing and reaches the caller as it was (two store clients over one host)', () => {
    const w = world(m)
    const h = hosted(m)
    const where = scope('c1', 7)
    const repoB = overClient(m, h.client(), w.registry)
    let fire = null
    const repoA = overClient(m, h.client((request) => {
      if (fire && (request.op === 'swap' || request.op === 'write')) {
        const run = fire

        fire = null
        run()
      }
    }), w.registry)
    const seen = []

    design(repoA, where)
    note(repoA, where)
    design(repoA, where, { precondition: (entries) => seen.push(entries.map((entry) => entry.record.kind)) })
    assert.deepEqual(seen, [['design-scenario']], 'the precondition reads the records of the kind made')

    // another window makes a record of the kind between the read and the swap: the precondition runs again over the file as stored then
    seen.length = 0
    fire = () => design(repoB, where, { payload: { title: 'from B', techIds: [] } })
    design(repoA, where, { payload: { title: 'from A', techIds: [] }, precondition: (entries) => seen.push(entries.length) })
    assert.deepEqual(seen, [2, 3])

    // a precondition that throws on that second run writes nothing and is thrown as it was
    const before = repoA.list(where).length
    const refusal = new Error('refused')
    let thrown = null

    fire = () => design(repoB, where, { payload: { title: 'B again', techIds: [] } })

    try {
      design(repoA, where, { precondition: (entries) => { if (entries.length > 4) { throw refusal } } })
    } catch (error) {
      thrown = error
    }

    assert.equal(thrown, refusal)
    assert.equal(repoA.list(where).length, before + 1, 'only the other window wrote')

    let refused = null

    try {
      design(repoA, where, { precondition: 'not a function' })
    } catch (error) {
      refused = error
    }

    assert.equal(refused && refused.code, 'invalid-record')
  })

  check('edits', 'a clone has a new uuid, revision 1 and the provenance of its source, and is independent of it', () => {
    const w = world(m)
    const where = scope('c1', 7)
    const source = design(w.repo, where, { policy: 'branch' })
    const edited = w.repo.update(where, source.uuid, 1, { payload: { title: 'Edited', techIds: [8] } })
    const copied = w.repo.clone(where, source.uuid)

    assert.notEqual(copied.uuid, source.uuid)
    assert.equal(copied.revision, 1)
    assert.deepEqual(copied.payload, edited.payload)
    assert.deepEqual(copied.links, edited.links)
    assert.deepEqual(copied.versions, edited.versions)
    assert.equal(copied.provenance.via, 'clone')
    assert.equal(copied.provenance.from.uuid, source.uuid)
    assert.equal(copied.provenance.from.revision, 2)
    assert.equal(copied.campaignId, 'c1')
    assert.equal(copied.RaceID, 7)
    assert.deepEqual(copied.association, edited.association)
    assert.deepEqual(copied.base, edited.base)

    w.repo.update(where, copied.uuid, 1, { payload: { title: 'Clone only', techIds: [] } })
    assert.equal(w.repo.read(where, source.uuid).payload.title, 'Edited')
    assert.equal(w.repo.list(where).length, 2)

    const moved = w.repo.clone(scope('c1', 7, 'b1', 2000), source.uuid, { rebase: true })

    assert.equal(moved.base.gameTime, 2000)
    assert.equal(w.repo.read(where, source.uuid).record.base.gameTime, 1000)
  })

  check('edits', 'a delete names the revision, removes only that record and returns it', () => {
    const w = world(m)
    const where = scope('c1', 7)
    const keep = note(w.repo, where)
    const drop = design(w.repo, where)

    w.repo.update(where, drop.uuid, 1, { assumptions: [] })
    conflictOf(() => w.repo.delete(where, drop.uuid, 1))
    refusal(() => w.repo.delete(where, drop.uuid), 'invalid-record')
    assert.equal(w.repo.list(where).length, 2)

    const removed = w.repo.delete(where, drop.uuid, 2)

    assert.equal(removed.uuid, drop.uuid)
    assert.deepEqual(w.repo.list(where).map((entry) => entry.record.uuid), [keep.uuid])
    refusal(() => w.repo.delete(where, drop.uuid, 2), 'not-found')
  })

  check('edits', 'an edit changes only the editable fields, bumps the revision and restamps the versions', () => {
    const w = world(m)
    const where = scope('c1', 7, 'b1', 1000)
    const made = design(w.repo, where)

    ;[{ uuid: 'x' }, { kind: 'colony-note' }, { RaceID: 8 }, { campaignId: 'c2' }, { provenance: { via: 'import' } }, { createdAt: 1 }, { revision: 9 }, { schema: 1 }, {}, null].forEach((patch) => {
      refusal(() => w.repo.update(where, made.uuid, 1, patch), 'invalid-record')
    })
    assert.equal(w.repo.read(where, made.uuid).record.revision, 1)

    const next = w.repo.update(scope('c1', 7, 'b1', 1500), made.uuid, 1, { payload: { title: 'More', techIds: [1, 2, 3] } })

    assert.equal(next.revision, 2)
    assert.equal(next.uuid, made.uuid)
    assert.equal(next.createdAt, made.createdAt)
    assert.ok(next.updatedAt > made.updatedAt)
    assert.deepEqual(next.versions, { 'design.rules': '2.7.x', techCount: 3 })
    assert.deepEqual(made.versions, { 'design.rules': '2.7.x', techCount: 2 })
    assert.equal(next.base.gameTime, 1000)

    const rebased = w.repo.update(scope('c1', 7, 'b1', 1500), made.uuid, 2, { rebase: true })

    assert.equal(rebased.base.gameTime, 1500)
    assert.deepEqual(rebased.payload, next.payload)
    assert.equal(w.repo.update(where, made.uuid, 3, { policy: 'branch' }).association.policy, 'branch')
    refusal(() => w.repo.update(where, made.uuid, 4, { policy: 'universe' }), 'invalid-record')
    refusal(() => w.repo.update(where, made.uuid, 4, { assumptions: 'text' }), 'invalid-record')
  })

  check('edits', 'a deleted uuid leaves a tombstone and is never issued, cloned, imported or kept again', () => {
    const w = world(m)
    const where = scope('c1', 7)
    const home = { campaignId: 'c1', RaceID: 7, branch: 'b1' }
    const made = design(w.repo, where)
    const bundle = w.repo.exportRecords(where)

    w.repo.update(where, made.uuid, 1, { assumptions: [] })
    w.repo.delete(where, made.uuid, 2)

    const stored = w.inst.files.get('campaign-c1')

    assert.deepEqual(stored.records, {})
    assert.deepEqual(Object.keys(stored.tombstones), [made.uuid])
    assert.equal(stored.tombstones[made.uuid].revision, 2)
    refusal(() => w.make({ newId: () => made.uuid }).create(where, { kind: 'colony-note', payload: { text: 'x' } }), 'collision')
    refusal(() => w.repo.update(where, made.uuid, 2, { assumptions: [] }), 'not-found')

    const preview = w.repo.previewImport(bundle, home, { keepUuids: true })

    assert.equal(preview.items[0].tombstoned, true)
    assert.equal(preview.items[0].collides, false)
    assert.equal(preview.items[0].keepsUuid, false)

    const done = w.repo.importRecords(bundle, home, { preview, keepUuids: true })

    assert.notEqual(done.imported[0].uuid, made.uuid)
    assert.equal(done.imported[0].provenance.from.uuid, made.uuid)
    assert.ok(w.inst.files.get('campaign-c1').tombstones[made.uuid])
    assert.equal(w.make().list(where).length, 1)
    refusal(() => w.make({ newId: () => made.uuid }).clone(where, done.imported[0].uuid), 'collision')
    assert.equal(w.repo.previewImport(bundle, { campaignId: 'c2', RaceID: 7, branch: 'b1' }, { keepUuids: true }).items[0].keepsUuid, true)
  })

  check('edits', 'an edit prepared before its record was deleted and restored from an export is refused, not applied to the restored record (two store clients over one host)', () => {
    const w = world(m)
    const h = hosted(m)
    const where = scope('c1', 7)
    const home = { campaignId: 'c1', RaceID: 7, branch: 'b1' }
    const repoB = overClient(m, h.client(), w.registry)
    let fire = null
    const repoA = overClient(m, h.client((request) => {
      if (fire && (request.op === 'swap' || request.op === 'write')) {
        const run = fire

        fire = null
        run()
      }
    }), w.registry)
    const made = design(repoA, where)
    const bundle = repoB.exportRecords(where)

    fire = () => {
      repoB.delete(where, made.uuid, 1)

      const preview = repoB.previewImport(bundle, home, { keepUuids: true })

      repoB.importRecords(bundle, home, { preview, keepUuids: true })
    }

    refusal(() => repoA.update(where, made.uuid, 1, { payload: { title: 'Window A, stale', techIds: [] } }), 'not-found')

    const listed = repoB.list(where)

    assert.equal(listed.length, 1)
    assert.equal(listed[0].payload.title, 'Corvette')
    assert.notEqual(listed[0].record.uuid, made.uuid)
    assert.equal(listed[0].record.provenance.from.uuid, made.uuid)
    assert.equal(listed[0].record.revision, 1)
  })

  // ---- versions ----------------------------------------------------------------------------------------------------

  check('versions', 'a restart over the persisted JSON reads the same file and writes nothing', () => {
    const w = world(m)
    const where = scope('c1', 7)

    design(w.repo, where)
    note(w.repo, where)

    const before = w.inst.snapshot()
    const writes = w.inst.writes.length
    const restarted = w.make()

    assert.deepEqual(restarted.list(where).map((entry) => entry.record), w.repo.list(where).map((entry) => entry.record))
    assert.equal(w.inst.snapshot(), before)
    assert.equal(w.inst.writes.length, writes)
    assert.equal(w.inst.files.get('campaign-c1').version, m.records.FILE_VERSION)
  })

  check('versions', 'a version-0 file is migrated with every payload and provenance exactly as it was', () => {
    const w = world(m)
    const fixture = version0()
    const where = scope('c1', 7, 'b1', 1000)

    w.inst.files.set('campaign-c1', copy(fixture))

    const writes = w.inst.writes.length
    const seen = w.repo.list(where)

    // a read migrates in memory only
    assert.deepEqual(seen.map((entry) => entry.record.uuid), [id(1)])
    assert.equal(seen[0].record.revision, 1)
    assert.equal(seen[0].record.association.policy, 'branch')
    assert.deepEqual(seen[0].record.base, { branchId: 'b1', gameTime: 500 })
    assert.equal(JSON.stringify(seen[0].record.payload), JSON.stringify(fixture.records[0].payload))
    assert.equal(JSON.stringify(seen[0].record.provenance), JSON.stringify(fixture.records[0].provenance))
    assert.deepEqual(seen[0].payload, { title: 'Old', techIds: [1, 2] })
    assert.deepEqual(w.inst.files.get('campaign-c1'), fixture)
    assert.equal(w.inst.writes.length, writes)
    assert.deepEqual(w.repo.list(scope('c1', 7, 'b2', 1000)).map((entry) => entry.record.uuid), [id(2)])
    assert.deepEqual(w.repo.list(scope('c1', 7, 'b3', 1000)), [])
    assert.deepEqual(w.repo.list(scope('c1', 8, 'b1', 1000)), [])

    // a write stores the migrated file
    const added = note(w.repo, where)
    const stored = w.inst.files.get('campaign-c1')

    assert.equal(stored.version, 1)
    assert.deepEqual(stored.migrated, [{ from: 0, to: 1 }])
    assert.deepEqual(Object.keys(stored.records).sort(), [id(1), id(2), added.uuid].sort())
    fixture.records.forEach((old) => {
      const record = stored.records[old.uuid]

      assert.equal(JSON.stringify(record.payload), JSON.stringify(old.payload))
      assert.equal(JSON.stringify(record.provenance), JSON.stringify(old.provenance))
      assert.equal(record.createdAt, old.createdAt)
      assert.equal(record.updatedAt, old.updatedAt)
      assert.equal(record.campaignId, old.campaignId)
      assert.equal(record.RaceID, old.RaceID)
      assert.equal(record.schema, old.schema)
      assert.deepEqual(record.association, { policy: 'branch', branchId: old.branchId })
      assert.equal(record.revision, 1)
    })

    // the old schema of the payload is the adapter's to migrate, on an edit
    const edited = w.repo.update(where, id(1), 1, { assumptions: [{ key: 'checked' }] })

    assert.deepEqual(edited.payload, { title: 'Old', techIds: [1, 2] })
    assert.equal(edited.schema, 2)
    assert.equal(JSON.stringify(edited.provenance), JSON.stringify(fixture.records[0].provenance))
    assert.equal(w.make().list(where).length, 2)
  })

  check('versions', 'a file of a newer version is refused with a reason and left untouched', () => {
    const w = world(m)

    design(w.repo, scope('c1', 7))

    const newer = { ...copy(w.inst.files.get('campaign-c1')), version: m.records.FILE_VERSION + 1, future: { kept: true } }

    w.inst.files.set('campaign-c1', newer)

    const before = w.inst.snapshot()
    const writes = w.inst.writes.length
    const error = refusal(() => w.repo.list(scope('c1', 7)), 'newer-version')

    assert.equal(error.version, m.records.FILE_VERSION + 1)
    assert.match(error.message, /newer version/)
    refusal(() => w.repo.read(scope('c1', 7), 'x'), 'newer-version')
    refusal(() => design(w.repo, scope('c1', 7)), 'newer-version')
    refusal(() => w.repo.exportRecords(scope('c1', 7)), 'newer-version')
    refusal(() => w.repo.previewImport({ format: 'aurora-scenario-records', version: 1, records: [] }, { campaignId: 'c1', RaceID: 7, branch: 'b1' }), 'newer-version')
    assert.equal(w.inst.snapshot(), before)
    assert.equal(w.inst.writes.length, writes)
  })

  check('versions', 'a damaged file is refused with a reason and left untouched, never read as empty', () => {
    const valid = (() => {
      const w = world(m)

      design(w.repo, scope('c1', 7))

      return copy(w.inst.files.get('campaign-c1'))
    })()
    const uuid = Object.keys(valid.records)[0]
    const variant = (change) => {
      const file = copy(valid)

      change(file, file.records[uuid])

      return file
    }
    const damaged = [
      ['text instead of an object', 'garbage'],
      ['a list', []],
      ['records as a list', { version: 1, records: [] }],
      ['no version', { records: copy(valid.records) }],
      ['a negative version', { version: -1, records: {} }],
      ['a fractional version', { version: 0.5, records: {} }],
      ['a record under another key', variant((file, record) => { file.records.other = record })],
      ['a record without a revision', variant((_file, record) => { delete record.revision })],
      ['a record with a zero revision', variant((_file, record) => { record.revision = 0 })],
      ['a record without its race', variant((_file, record) => { delete record.RaceID })],
      ['a race kept as text', variant((_file, record) => { record.RaceID = '7' })],
      ['a record of another campaign', variant((_file, record) => { record.campaignId = 'c9' })],
      ['a payload that is not an object', variant((_file, record) => { record.payload = 'text' })],
      ['a link without a fingerprint', variant((_file, record) => { delete record.links[0].fingerprint })],
      ['a policy nobody defined', variant((_file, record) => { record.association.policy = 'galaxy' })],
      ['a base without a game time', variant((_file, record) => { delete record.base.gameTime })],
      ['version-0 records that are not a list', { version: 0, records: {} }],
      ['version-0 records with a repeated uuid', { version: 0, records: [version0().records[0], version0().records[0]] }],
      ['a version-0 record without its provenance', { version: 0, records: [omit(version0().records[0], 'provenance')] }],
      ['a record that is also a tombstone', variant((file) => { file.tombstones = { [uuid]: { revision: 1, deletedAt: 1 } } })],
      ['a tombstone that is not valid', variant((file) => { file.tombstones = { [id(5)]: { revision: 0 } } })],
      ['tombstones that are not a map', variant((file) => { file.tombstones = [] })],
      ['a uuid that is not canonical text', variant((file, record) => { delete file.records[uuid]; file.records['not-a-uuid'] = { ...record, uuid: 'not-a-uuid' } })],
      ['a record keyed __proto__', JSON.parse(`{"version":1,"records":{"__proto__":${JSON.stringify({ ...valid.records[uuid], uuid: '__proto__' })}}}`)],
      ['a version-0 record with a __proto__ uuid', { version: 0, records: [{ ...version0().records[0], uuid: '__proto__' }] }],
    ]

    damaged.forEach(([label, content]) => {
      const w = world(m)

      w.inst.files.set('campaign-c1', content)

      const before = w.inst.snapshot()
      const where = scope('c1', 7)

      refusal(() => w.repo.list(where), 'damaged')
      refusal(() => w.repo.read(where, uuid), 'damaged')
      refusal(() => design(w.repo, where), 'damaged')
      refusal(() => w.repo.update(where, uuid, 1, { assumptions: [] }), 'damaged')
      refusal(() => w.repo.delete(where, uuid, 1), 'damaged')
      refusal(() => w.repo.previewImport({ format: 'aurora-scenario-records', version: 1, records: [] }, { campaignId: 'c1', RaceID: 7, branch: 'b1' }), 'damaged')
      assert.equal(w.inst.snapshot(), before, label)
      assert.equal(w.inst.writes.length, 0, label)
    })

    // an absent file is an empty one
    const empty = world(m)

    assert.deepEqual(empty.repo.list(scope('c1', 7)), [])
    assert.equal(design(empty.repo, scope('c1', 7)).revision, 1)
  })

  check('versions', 'an older adapter schema is migrated for the view and on an edit, and a stored payload changes only then', () => {
    const w = world(m)
    const where = scope('c1', 7)
    const fixture = { version: 1, records: {} }
    const old = (() => {
      const probe = world(m)
      const made = design(probe.repo, where)

      return { ...copy(made), uuid: id(11), schema: 1, payload: { name: 'Legacy', tech: [7] } }
    })()

    fixture.records[old.uuid] = old
    w.inst.files.set('campaign-c1', fixture)

    const before = w.inst.snapshot()
    const shown = w.repo.list(where)[0]

    assert.deepEqual(shown.payload, { title: 'Legacy', techIds: [7] })
    assert.deepEqual(shown.record.payload, { name: 'Legacy', tech: [7] })
    assert.equal(shown.record.schema, 1)
    assert.deepEqual(shown.flags, [])
    assert.equal(w.inst.snapshot(), before)

    const edited = w.repo.update(where, old.uuid, 1, { assumptions: [] })

    assert.equal(edited.schema, 2)
    assert.deepEqual(edited.payload, { title: 'Legacy', techIds: [7] })
    assert.deepEqual(edited.versions, { 'design.rules': '2.7.x', techCount: 1 })
  })

  check('versions', 'a record of a newer schema or of an unknown kind is listed with a flag, its payload untouched, and is not edited', () => {
    const w = world(m)
    const where = scope('c1', 7)
    const base = design(w.repo, where)
    const newer = { ...copy(base), uuid: id(12), schema: 3, payload: { shape: 'from the future' } }
    const ghost = { ...copy(base), uuid: id(13), kind: 'retired-planner', schema: 1, payload: { anything: [1, 2] } }
    const file = copy(w.inst.files.get('campaign-c1'))

    file.records[newer.uuid] = newer
    file.records[ghost.uuid] = ghost
    w.inst.files.set('campaign-c1', file)

    const before = w.inst.snapshot()
    const listed = w.repo.list(where)
    const byId = (uuid) => listed.find((entry) => entry.record.uuid === uuid)

    assert.ok(byId(id(12)).flags.includes('newer-schema'))
    assert.deepEqual(byId(id(12)).payload, { shape: 'from the future' })
    assert.ok(byId(id(13)).flags.includes('no-adapter'))
    assert.deepEqual(byId(id(13)).payload, { anything: [1, 2] })
    assert.deepEqual(byId(base.uuid).flags, [])
    refusal(() => w.repo.update(where, id(12), 1, { assumptions: [] }), 'unsupported-schema')
    refusal(() => w.repo.update(where, id(13), 1, { assumptions: [] }), 'no-adapter')
    assert.equal(w.inst.snapshot(), before)
    assert.equal(w.repo.delete(where, id(13), 1).uuid, id(13))
    assert.equal(w.repo.read(where, id(13)), null)
  })

  check('versions', 'a malformed browser storage entry is refused with the raw value untouched, never read as an empty file', async () => {
    const storage = fakeLocalStorage()
    const key = 'aurora-electrons:scenarios/campaign-cweb'

    globalThis.localStorage = storage

    try {
      const repository = m.records.createRepository({ storage: m.records.createScenarioStorage({ Store: m.Shim, locks: fakeLocks() }), adapters: adapters(m) })
      const where = scope('cweb', 7)

      assert.equal(await repository.writable('cweb', 200), true)

      ;['{broken JSON', '{"version":1,"records":{'].forEach((raw) => {
        storage.items.set(key, raw)
        assert.match(String(thrown(() => repository.list(where))), /damaged/)
        assert.match(String(thrown(() => design(repository, where))), /damaged/)
        assert.match(String(thrown(() => repository.exportRecords(where))), /damaged/)
        assert.equal(storage.items.get(key), raw)
      })

      storage.items.delete(key)
      assert.deepEqual(repository.list(where), [])

      storage.items.set('aurora-electrons:history/campaigns', '{broken')
      refusal(() => repository.listAttached(where), 'registry-unreadable')
      assert.equal(storage.items.get('aurora-electrons:history/campaigns'), '{broken')
    } finally {
      delete globalThis.localStorage
    }
  })

  check('versions', 'a browser storage entry that parses to null, false, 0, a string or a list is a damaged file, never an empty one, and is left as stored', async () => {
    const storage = fakeLocalStorage()
    const key = 'aurora-electrons:scenarios/campaign-cweb'

    globalThis.localStorage = storage

    try {
      const repository = m.records.createRepository({ storage: m.records.createScenarioStorage({ Store: m.Shim, locks: fakeLocks() }), adapters: adapters(m) })
      const where = scope('cweb', 7)

      assert.equal(await repository.writable('cweb', 200), true)

      ;['null', 'false', '0', '""', '[]'].forEach((raw) => {
        storage.items.set(key, raw)
        refusal(() => repository.list(where), 'damaged')
        refusal(() => design(repository, where), 'damaged')
        refusal(() => repository.exportRecords(where), 'damaged')
        assert.equal(storage.items.get(key), raw)
      })
    } finally {
      delete globalThis.localStorage
    }
  })

  check('versions', 'the web shim reads an ordinary store as empty whatever it holds, and only a store opened strict refuses what it cannot read', () => {
    const storage = fakeLocalStorage()

    globalThis.localStorage = storage

    try {
      ;[['aurora-electrons:config', {}], ['aurora-electrons:scenarios/campaign-cweb', { cwd: 'scenarios', name: 'campaign-cweb' }]].forEach(([key, options]) => {
        ;['{broken', 'null', 'false', '0'].forEach((raw) => {
          storage.items.set(key, raw)

          const ordinary = new m.Shim(options)

          assert.deepEqual(ordinary.store, {})
          assert.equal(ordinary.get('anything', 'fallback'), 'fallback')
          assert.equal(storage.items.get(key), raw)
        })

        storage.items.set(key, '{broken')
        assert.match(String(thrown(() => new m.Shim({ ...options, strict: true }).store)), /damaged/)
        assert.match(String(thrown(() => new m.Shim({ ...options, strict: true }).get('anything'))), /damaged/)
        assert.equal(storage.items.get(key), '{broken')

        storage.items.set(key, 'false')
        assert.equal(new m.Shim({ ...options, strict: true }).store, false)
        storage.items.delete(key)
        assert.deepEqual(new m.Shim({ ...options, strict: true }).store, {})
      })
    } finally {
      delete globalThis.localStorage
    }
  })

  // ---- adapters ----------------------------------------------------------------------------------------------------

  check('adapters', 'an adapter that rejects a payload is obeyed on create and update, and a payload that is not JSON is refused', () => {
    const w = world(m)
    const where = scope('c1', 7)
    const made = design(w.repo, where)
    const before = w.inst.snapshot()
    const bad = [{ title: 5, techIds: [] }, { title: 'x' }, {}, 'text', null, [], { title: 'x', techIds: [], extra: () => 1 }, { title: 'x', techIds: [], n: Number.NaN }, { title: 'x', techIds: [undefined] }, { title: 'x', techIds: [Infinity] }]

    bad.forEach((payload) => {
      refusal(() => w.repo.create(where, { kind: 'design-scenario', payload }), 'invalid-payload')
      refusal(() => w.repo.update(where, made.uuid, 1, { payload }), 'invalid-payload')
    })

    assert.deepEqual(refusal(() => w.repo.create(where, { kind: 'design-scenario', payload: {} }), 'invalid-payload').problems, ['a design scenario has a title and a list of techIds'])
    refusal(() => w.repo.create(where, { kind: 'colony-note', payload: { text: 5 } }), 'invalid-payload')
    refusal(() => w.repo.create(where, { kind: 'unknown-planner', payload: { text: 'x' } }), 'no-adapter')
    refusal(() => w.repo.create(where, { kind: 'colony-note', payload: { text: 'x' }, policy: 'galaxy' }), 'invalid-record')
    assert.equal(w.inst.snapshot(), before)
    assert.equal(w.repo.create(where, { kind: 'colony-note', payload: { text: 'fine' } }).payload.text, 'fine')
  })

  check('adapters', 'an adapter whose validation throws refuses the payload and a registration is checked', () => {
    const w = world(m)
    const registry = m.records.createAdapterRegistry()
    const good = { kind: 'k', schema: 1, validate: () => [] }

    registry.register({ kind: 'throws', schema: 1, validate: () => { throw new Error('boom') } })
    registry.register(good)
    refusal(() => registry.register(good), 'invalid-adapter')
    refusal(() => registry.register({ ...good, kind: 'a b' }), 'invalid-adapter')
    refusal(() => registry.register({ ...good, kind: 'no-validate', validate: undefined }), 'invalid-adapter')
    refusal(() => registry.register({ ...good, kind: 'schema-0', schema: 0 }), 'invalid-adapter')
    refusal(() => registry.register({ ...good, kind: 'no-migrate', schema: 2 }), 'invalid-adapter')
    refusal(() => registry.register({ ...good, kind: 'half', fingerprint: () => 'x' }), 'invalid-adapter')
    refusal(() => registry.register({ ...good, kind: 'versions', versions: 5 }), 'invalid-adapter')
    refusal(() => registry.register(null), 'invalid-adapter')
    assert.equal(registry.get('nope'), null)
    assert.deepEqual(registry.kinds(), ['throws', 'k'])

    const repository = m.records.createRepository({ storage: w.inst.storage, adapters: registry })

    refusal(() => repository.create(scope(), { kind: 'throws', payload: {} }), 'invalid-payload')
    refusal(() => repository.create(scope(), { kind: 'nope', payload: {} }), 'no-adapter')
    assert.equal(w.inst.writes.length, 0)
  })

  check('adapters', 'a link is given with a fingerprint or a row the adapter can fingerprint, and an adapter without fingerprints cannot link by row', () => {
    const w = world(m)
    const where = scope('c1', 7)
    const registry = m.records.createAdapterRegistry()

    registry.register({ kind: 'plain', schema: 1, validate: () => [] })

    const plain = m.records.createRepository({ storage: w.inst.storage, adapters: registry })

    refusal(() => plain.create(where, { kind: 'plain', payload: {}, links: [{ type: 't', id: 1, row: { a: 1 } }] }), 'invalid-record')
    assert.equal(plain.create(where, { kind: 'plain', payload: {}, links: [{ type: 't', id: 1, fingerprint: 'fp' }] }).links[0].fingerprint, 'fp')
    assert.equal(plain.list(where)[0].links[0].status, 'unknown')
    refusal(() => w.repo.create(where, { kind: 'colony-note', payload: { text: 'x' }, links: [{ type: 'colony', id: {}, row: classRow('A', 1) }] }), 'invalid-record')
    refusal(() => w.repo.create(where, { kind: 'colony-note', payload: { text: 'x' }, links: 'none' }), 'invalid-record')
  })

  check('adapters', 'the repository writes only the file of the campaign it was asked about', () => {
    const w = world(m)

    design(w.repo, scope('c1', 7))
    note(w.repo, scope('c1', 8))
    w.repo.list(scope('c2', 7))
    w.repo.exportRecords(scope('c3', 7))
    assert.deepEqual([...new Set(w.inst.writes)], ['campaign-c1'])
    assert.deepEqual([...w.inst.files.keys()], ['campaign-c1'])
    note(w.repo, scope('c2', 7))
    assert.deepEqual([...new Set(w.inst.writes)].sort(), ['campaign-c1', 'campaign-c2'])
    assert.ok(thrown(() => m.records.createRepository({ storage: { open: () => ({ store: {} }) } }).list(scope())) instanceof TypeError)
  })

  // ---- import and export -------------------------------------------------------------------------------------------

  const exported = () => {
    const w = world(m)
    const where = scope('c1', 7)
    const a = design(w.repo, where, { policy: 'branch' })
    const b = note(w.repo, where)

    design(w.repo, scope('c1', 8), { payload: { title: 'other race', techIds: [] } })
    design(w.repo, scope('c1', 7, 'b2'), { payload: { title: 'other branch', techIds: [] }, policy: 'branch' })

    return { w, where, a, b, bundle: w.repo.exportRecords(where) }
  }

  const TARGET = { campaignId: 'c2', RaceID: 8, branch: 'b9' }

  check('import', 'an export carries the visible records with their provenance and the scope they came from', () => {
    const { w, where, a, b, bundle } = exported()

    assert.equal(bundle.format, 'aurora-scenario-records')
    assert.equal(bundle.version, 1)
    assert.deepEqual(bundle.source, { campaignId: 'c1', RaceID: 7, branchId: 'b1', gameTime: 1000 })
    assert.deepEqual(bundle.records.map((record) => record.uuid).sort(), [a.uuid, b.uuid].sort())
    assert.ok(bundle.records.every((record) => record.campaignId === 'c1' && record.RaceID === 7 && record.provenance.via === 'created'))
    assert.deepEqual(w.repo.exportRecords(where, { kind: 'colony-note' }).records.map((record) => record.uuid), [b.uuid])
    assert.deepEqual(w.repo.exportRecords(where, { uuids: [a.uuid] }).records.map((record) => record.uuid), [a.uuid])
    assert.equal(w.repo.exportRecords(where, { uuids: [] }).records.length, 0)
    assert.equal(JSON.stringify(bundle), JSON.stringify(JSON.parse(JSON.stringify(bundle))))
  })

  check('import', 'an import without an explicit target is refused and writes nothing', () => {
    const { w, bundle } = exported()
    const preview = w.repo.previewImport(bundle, TARGET)
    const before = w.inst.snapshot()
    const writes = w.inst.writes.length

    ;[undefined, null, {}, { campaignId: 'c2' }, { campaignId: 'c2', RaceID: 8 }, { campaignId: 'c2', branch: 'b9' }, { RaceID: 8, branch: 'b9' }, { campaignId: 'c2', RaceID: '8', branch: 'b9' }, { campaignId: '../c2', RaceID: 8, branch: 'b9' }, 'c2'].forEach((target) => {
      refusal(() => w.repo.previewImport(bundle, target), 'invalid-target')
      refusal(() => w.repo.importRecords(bundle, target, { preview }), 'invalid-target')
    })

    assert.equal(w.inst.snapshot(), before)
    assert.equal(w.inst.writes.length, writes)
  })

  check('import', 'an import is made from the preview of the same bundle and target, and a preview writes nothing', () => {
    const { w, bundle } = exported()
    const before = w.inst.snapshot()
    const writes = w.inst.writes.length
    const preview = w.repo.previewImport(bundle, TARGET)

    assert.equal(preview.importable, 2)
    assert.equal(preview.rejected, 0)
    assert.ok(preview.items.every((item) => item.status === 'import' && item.foreign === true && item.keepsUuid === false))
    assert.equal(w.inst.snapshot(), before)
    assert.equal(w.inst.writes.length, writes)

    refusal(() => w.repo.importRecords(bundle, TARGET), 'preview-required')
    refusal(() => w.repo.importRecords(bundle, TARGET, { preview: {} }), 'preview-required')
    refusal(() => w.repo.importRecords(bundle, TARGET, { preview: 'ok' }), 'preview-required')
    refusal(() => w.repo.importRecords(bundle, { ...TARGET, RaceID: 9 }, { preview }), 'preview-mismatch')
    refusal(() => w.repo.importRecords(bundle, { ...TARGET, branch: 'b1' }, { preview }), 'preview-mismatch')
    refusal(() => w.repo.importRecords(bundle, TARGET, { preview, keepUuids: true }), 'preview-mismatch')
    refusal(() => w.repo.importRecords({ ...bundle, records: bundle.records.slice(1) }, TARGET, { preview }), 'preview-mismatch')
    refusal(() => w.repo.importRecords({ ...bundle, records: [{ ...bundle.records[0], payload: { title: 'tampered', techIds: [] } }, ...bundle.records.slice(1)] }, TARGET, { preview }), 'preview-mismatch')
    assert.equal(w.inst.snapshot(), before)

    const done = w.repo.importRecords(bundle, TARGET, { preview })

    assert.equal(done.imported.length, 2)
    assert.equal(done.rejected.length, 0)
  })

  check('import', 'an imported record takes a new uuid and the target\'s campaign, race and branch, keeps its provenance and base, and is never rebound', () => {
    const { w, a, b, bundle } = exported()
    const before = copy(w.inst.files.get('campaign-c1'))
    const preview = w.repo.previewImport(bundle, TARGET)
    const done = w.repo.importRecords(bundle, TARGET, { preview })
    const at = scope('c2', 8, 'b9', 1000)
    const listed = w.repo.list(at, { context: rows('ship-class', 5, classRow('Frigate', 20)) })

    assert.equal(listed.length, 2)
    assert.ok(done.imported.every((record) => ![a.uuid, b.uuid].includes(record.uuid)))
    assert.deepEqual(done.ids.map((id) => id.from).sort(), [a.uuid, b.uuid].sort())
    assert.deepEqual(listed.map((entry) => entry.record.uuid).sort(), done.imported.map((record) => record.uuid).sort())
    listed.forEach((entry) => {
      const source = [a, b].find((record) => record.uuid === entry.record.provenance.from.uuid)

      assert.equal(entry.record.campaignId, 'c2')
      assert.equal(entry.record.RaceID, 8)
      assert.equal(entry.record.association.branchId, 'b9')
      assert.equal(entry.record.association.policy, source.association.policy)
      assert.equal(entry.record.revision, 1)
      assert.equal(entry.record.provenance.via, 'import')
      assert.equal(entry.record.provenance.from.campaignId, 'c1')
      assert.equal(entry.record.provenance.from.RaceID, 7)
      assert.equal(entry.record.provenance.from.revision, 1)
      assert.deepEqual(entry.record.provenance.from.source, bundle.source)
      assert.deepEqual(entry.record.base, source.base)
      assert.deepEqual(entry.record.versions, source.versions)
      assert.deepEqual(entry.payload, source.payload)
      assert.deepEqual(entry.links.map((link) => [link.id, link.fingerprint]), source.links.map((link) => [link.id, link.fingerprint]))
    })

    // the imported link names the same local ID, which is another object (or none) in the target's save
    const designEntry = listed.find((entry) => entry.record.kind === 'design-scenario')

    assert.equal(designEntry.links[0].status, 'changed')
    assert.equal(listed.find((entry) => entry.record.kind === 'colony-note').links[0].status, 'missing')

    // the source and every other scope are untouched
    assert.deepEqual(w.inst.files.get('campaign-c1'), before)
    assert.deepEqual(w.repo.list(scope('c2', 7, 'b9')), [])
    assert.deepEqual(w.repo.list(scope('c1', 8, 'b9')).map((entry) => entry.record.kind), ['design-scenario'])
    assert.deepEqual(w.repo.list(scope('c2', 8, 'b1')).map((entry) => entry.record.kind), ['colony-note'])
  })

  check('import', 'keeping uuids is explicit and refused where a record of the target campaign has the uuid', () => {
    const { w, a, bundle } = exported()
    const keep = w.repo.previewImport(bundle, TARGET, { keepUuids: true })

    assert.ok(keep.items.every((item) => item.keepsUuid && !item.collides))

    const kept = w.repo.importRecords(bundle, TARGET, { preview: keep, keepUuids: true })

    assert.deepEqual(kept.imported.map((record) => record.uuid).sort(), bundle.records.map((record) => record.uuid).sort())

    // the same bundle again into the same campaign collides and takes new uuids, without touching the records there
    const again = w.repo.previewImport(bundle, { ...TARGET, branch: 'b3' }, { keepUuids: true })

    assert.ok(again.items.every((item) => item.collides && !item.keepsUuid))

    const second = w.repo.importRecords(bundle, { ...TARGET, branch: 'b3' }, { preview: again, keepUuids: true })

    assert.ok(second.imported.every((record) => !bundle.records.some((source) => source.uuid === record.uuid)))
    assert.equal(w.repo.read(scope('c2', 8, 'b9'), a.uuid).record.association.branchId, 'b9')
    assert.equal(Object.keys(w.inst.files.get('campaign-c2').records).length, 4)

    // the source campaign is the target: its own uuids collide
    const home = w.repo.previewImport(bundle, { campaignId: 'c1', RaceID: 7, branch: 'b1' }, { keepUuids: true })

    assert.ok(home.items.every((item) => item.collides && !item.foreign))
  })

  check('import', 'a restore of records keeps the uuid of every record the file neither holds nor held, skips the rest as the file is inside the import, and never copies or brings back a record', () => {
    const home = { campaignId: 'c1', RaceID: 7, branch: 'b1' }
    const whole = exported()
    const uuids = whole.bundle.records.map((record) => record.uuid)

    // a restore into the file the records came from skips every one: they are held, and none is copied under a new uuid
    const held = whole.w.repo.previewImport(whole.bundle, home, { restore: true })
    const before = whole.w.inst.snapshot()

    assert.equal(held.restore, true)
    assert.deepEqual(held.items.map((item) => item.status), ['skipped', 'skipped'])
    assert.ok(held.items.every((item) => item.collides && !item.keepsUuid))
    assert.equal(held.importable, 0)
    assert.equal(whole.w.repo.importRecords(whole.bundle, home, { preview: held, restore: true }).imported.length, 0)
    assert.equal(whole.w.inst.snapshot(), before)

    // a preview is of its policy: a restore preview is not an import preview and the other way round
    const plain = whole.w.repo.previewImport(whole.bundle, TARGET, { keepUuids: true })
    const restoring = whole.w.repo.previewImport(whole.bundle, TARGET, { restore: true })

    assert.notEqual(plain.digest, restoring.digest)
    refusal(() => whole.w.repo.importRecords(whole.bundle, TARGET, { preview: restoring, keepUuids: true }), 'preview-mismatch')
    refusal(() => whole.w.repo.importRecords(whole.bundle, TARGET, { preview: plain, restore: true }), 'preview-mismatch')
    refusal(() => whole.w.repo.importRecords(whole.bundle, TARGET, { preview: restoring }), 'preview-mismatch')

    // another campaign: every record keeps its uuid, with the provenance of any import
    assert.deepEqual(restoring.items.map((item) => [item.status, item.keepsUuid]), [['import', true], ['import', true]])

    const done = whole.w.repo.importRecords(whole.bundle, TARGET, { preview: restoring, restore: true })

    assert.deepEqual(done.imported.map((record) => record.uuid), uuids)
    done.imported.forEach((record) => {
      assert.equal(record.campaignId, 'c2')
      assert.equal(record.revision, 1)
      assert.equal(record.provenance.via, 'import')
      assert.ok(uuids.includes(record.provenance.from.uuid))
    })

    // a deleted record stays deleted: it is skipped and its uuid is not issued again
    const gone = exported()
    const goneIds = gone.bundle.records.map((record) => record.uuid)

    gone.w.repo.delete(scope('c1', 7), goneIds[0], 1)

    const deleted = gone.w.repo.previewImport(gone.bundle, home, { restore: true })

    assert.deepEqual(deleted.items.map((item) => [item.status, item.collides, item.tombstoned]), [['skipped', false, true], ['skipped', true, false]])
    assert.equal(gone.w.repo.importRecords(gone.bundle, home, { preview: deleted, restore: true }).imported.length, 0)
    assert.deepEqual(Object.keys(gone.w.inst.files.get('campaign-c1').records).filter((uuid) => goneIds.includes(uuid)), [goneIds[1]])
    assert.equal(Object.keys(gone.w.inst.files.get('campaign-c1').records).length, 3)
    assert.deepEqual(Object.keys(gone.w.inst.files.get('campaign-c1').tombstones), [goneIds[0]])

    // a record stored after the preview is not copied: the skip is decided inside the import
    const stored = exported()
    const storedIds = stored.bundle.records.map((record) => record.uuid)
    const early = stored.w.repo.previewImport(stored.bundle, TARGET, { restore: true })
    const single = { ...stored.bundle, records: [stored.bundle.records[0]] }

    stored.w.repo.importRecords(single, TARGET, { preview: stored.w.repo.previewImport(single, TARGET, { restore: true }), restore: true })

    const late = stored.w.repo.importRecords(stored.bundle, TARGET, { preview: early, restore: true })

    assert.deepEqual(late.imported.map((record) => record.uuid), [storedIds[1]])
    assert.deepEqual(Object.keys(stored.w.inst.files.get('campaign-c2').records).sort(), [...storedIds].sort())

    // a record stored and then deleted after the preview is not brought back
    const removed = exported()
    const removedIds = removed.bundle.records.map((record) => record.uuid)
    const first = removed.w.repo.previewImport(removed.bundle, TARGET, { restore: true })
    const one = { ...removed.bundle, records: [removed.bundle.records[0]] }

    removed.w.repo.importRecords(one, TARGET, { preview: removed.w.repo.previewImport(one, TARGET, { restore: true }), restore: true })
    removed.w.repo.delete(scope('c2', 8, 'b9'), removedIds[0], 1)

    const after = removed.w.repo.importRecords(removed.bundle, TARGET, { preview: first, restore: true })

    assert.deepEqual(after.imported.map((record) => record.uuid), [removedIds[1]])
    assert.deepEqual(Object.keys(removed.w.inst.files.get('campaign-c2').records), [removedIds[1]])
    assert.deepEqual(Object.keys(removed.w.inst.files.get('campaign-c2').tombstones), [removedIds[0]])

    // a uuid twice in a bundle is rejected, not restored once and copied once
    const twice = exported()
    const repeated = { ...twice.bundle, records: [twice.bundle.records[0], twice.bundle.records[0]] }
    const repeats = twice.w.repo.previewImport(repeated, TARGET, { restore: true })

    assert.deepEqual(repeats.items.map((item) => item.status), ['import', 'rejected'])
    assert.match(repeats.items[1].reasons.join(' '), /uuid/)
    assert.deepEqual(twice.w.repo.importRecords(repeated, TARGET, { preview: repeats, restore: true }).imported.map((record) => record.uuid), [twice.bundle.records[0].uuid])
  })

  check('import', 'an import never takes a record its adapter rejects, a kind it does not know, a newer schema or a malformed record', () => {
    const { w, bundle } = exported()
    const tampered = copy(bundle)
    const [first, second] = tampered.records
    const extra = (change) => ({ ...copy(first), ...change })

    first.payload = { title: 5, techIds: 'x' }
    second.kind = 'retired-planner'
    tampered.records.push(extra({ uuid: id(21), kind: 'design-scenario', schema: 9, payload: { title: 'x', techIds: [] } }))
    tampered.records.push('not a record')
    tampered.records.push(extra({ uuid: id(22), revision: undefined, payload: { title: 'x', techIds: [] } }))
    tampered.records.push(extra({ uuid: id(23), payload: { title: 'fine', techIds: [] } }))
    tampered.records.push(extra({ uuid: id(23), payload: { title: 'repeated', techIds: [] } }))
    tampered.records.push(extra({ uuid: id(24), schema: 1, payload: { name: 'Legacy', tech: [4] } }))

    const preview = w.repo.previewImport(tampered, TARGET)
    const statuses = preview.items.map((item) => item.status)

    assert.deepEqual(statuses, ['rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'import', 'rejected', 'import'])
    assert.ok(preview.items.every((item) => item.status === 'import' || item.reasons.length > 0))
    assert.match(preview.items[0].reasons.join(' '), /adapter refused/)
    assert.match(preview.items[1].reasons.join(' '), /no adapter/)
    assert.equal(preview.items[7].migratedFrom, 1)
    assert.equal(preview.importable, 2)
    assert.equal(preview.rejected, 6)

    const done = w.repo.importRecords(tampered, TARGET, { preview })
    const stored = w.repo.list(scope('c2', 8, 'b9'))

    assert.equal(done.imported.length, 2)
    assert.equal(done.rejected.length, 6)
    assert.deepEqual(stored.map((entry) => entry.payload.title).sort(), ['Legacy', 'fine'])
    assert.ok(stored.every((entry) => entry.record.schema === 2))

    refusal(() => w.repo.previewImport({ ...bundle, format: 'something else' }, TARGET), 'invalid-bundle')
    refusal(() => w.repo.previewImport({ ...bundle, version: 2 }, TARGET), 'invalid-bundle')
    refusal(() => w.repo.previewImport({ ...bundle, version: 0 }, TARGET), 'invalid-bundle')
    refusal(() => w.repo.previewImport({ ...bundle, records: {} }, TARGET), 'invalid-bundle')
    refusal(() => w.repo.previewImport(null, TARGET), 'invalid-bundle')
    refusal(() => w.repo.importRecords({ ...bundle, version: 2 }, TARGET, { preview }), 'invalid-bundle')
  })

  check('import', 'a bundle record whose uuid is not canonical text, __proto__ included, is rejected in the preview and never reported as imported', () => {
    const { w, bundle } = exported()
    const evil = copy(bundle)

    evil.records[0].uuid = '__proto__'
    evil.records[1].uuid = 'not-a-uuid'

    const preview = w.repo.previewImport(evil, TARGET, { keepUuids: true })

    assert.deepEqual(preview.items.map((item) => item.status), ['rejected', 'rejected'])
    preview.items.forEach((item) => assert.match(item.reasons.join(' '), /uuid/))
    assert.equal(w.repo.importRecords(evil, TARGET, { preview, keepUuids: true }).imported.length, 0)
    assert.deepEqual(w.repo.list(scope('c2', 8, 'b9')), [])

    const mixed = copy(bundle)

    mixed.records[0].uuid = '__proto__'

    const done = w.repo.importRecords(mixed, TARGET, { preview: w.repo.previewImport(mixed, TARGET, { keepUuids: true }), keepUuids: true })

    assert.equal(done.imported.length, 1)
    assert.equal(w.repo.list(scope('c2', 8, 'b9')).length, 1)
  })

  // ---- wiring ------------------------------------------------------------------------------------------------------

  check('wiring', 'the factory opens one file per campaign through the store client and host, and two windows see one another', async () => {
    const h = hosted(m)
    const Remote = h.client()
    const registry = adapters(m)

    globalThis.__scenarioStore = Remote

    try {
      const first = m.records.openScenarioRecords({ adapters: registry })
      const second = overClient(m, h.client(), registry)
      const where = scope('chost', 7)
      const made = design(first, where)
      const other = note(first, scope('chost-2', 7))

      assert.deepEqual([...h.files.keys()].sort(), ['scenarios/campaign-chost', 'scenarios/campaign-chost-2'])
      assert.equal(h.files.get('scenarios/campaign-chost').version, m.records.FILE_VERSION)
      assert.deepEqual(Object.keys(h.files.get('scenarios/campaign-chost').records), [made.uuid])
      assert.deepEqual(Object.keys(h.files.get('scenarios/campaign-chost-2').records), [other.uuid])
      assert.deepEqual(second.list(where).map((entry) => entry.record), [made])
      assert.deepEqual(second.list(scope('chost', 8)), [])
      assert.equal(m.records.scenarioStorage().open('chost'), m.records.scenarioStorage().open('chost'))
      assert.equal(new Remote({ cwd: 'scenarios', name: 'campaign-chost' }).path, 'scenarios/campaign-chost')
      assert.equal(await first.writable('chost'), true)

      second.update(where, made.uuid, 1, { assumptions: [{ key: 'second window' }] })
      conflictOf(() => first.update(where, made.uuid, 1, { assumptions: [] }))
      assert.equal(first.update(where, made.uuid, 2, { assumptions: [] }).revision, 3)

      // the registry of campaigns is read through the same store client, in the folder the recorder keeps it in
      h.files.set('history/campaigns', { campaigns: { chost: campaignEntry('chost'), 'chost-old': campaignEntry('chost-old', { campaignId: 'chost', branchId: 'b1', at: 1 }) } })

      const oldNote = note(first, scope('chost-old', 7))

      assert.deepEqual(first.listAttached(where).entries.map((entry) => entry.record.uuid), [oldNote.uuid])
      assert.equal(first.adopt(where, 'chost-old', oldNote.uuid).provenance.from.campaignId, 'chost-old')
    } finally {
      delete globalThis.__scenarioStore
    }
  })

  check('wiring', 'two tabs of web mode: the tab holding the file\'s lock writes, the other reads, and neither edit is lost', async () => {
    const storage = fakeLocalStorage()
    const locks = fakeLocks()
    const registry = adapters(m)
    const key = 'aurora-electrons:scenarios/campaign-cweb'

    globalThis.localStorage = storage

    try {
      const tabA = m.records.createScenarioStorage({ Store: m.Shim, locks })
      const tabB = m.records.createScenarioStorage({ Store: m.Shim, locks })
      const repoA = m.records.createRepository({ storage: tabA, adapters: registry })
      const repoB = m.records.createRepository({ storage: tabB, adapters: registry })
      const where = scope('cweb', 7)

      refusal(() => design(repoA, where), 'not-owner')
      assert.equal(await repoA.writable('cweb', 200), true)
      assert.equal(await repoB.writable('cweb', 30), false)

      const made = design(repoA, where)
      const written = storage.items.get(key)

      assert.deepEqual(storage.items.size, 1)
      assert.deepEqual(repoB.list(where).map((entry) => entry.record.uuid), [made.uuid])
      refusal(() => design(repoB, where), 'not-owner')
      refusal(() => repoB.update(where, made.uuid, 1, { assumptions: [] }), 'not-owner')
      refusal(() => repoB.clone(where, made.uuid), 'not-owner')
      refusal(() => repoB.delete(where, made.uuid, 1), 'not-owner')
      assert.equal(storage.items.get(key), written)

      // the interleaving that lost an edit: the other tab writes after this one has read the file and before it writes it
      const read = storage.getItem
      let reads = 0

      storage.getItem = (name) => {
        const value = read(name)

        if (name === key && reads++ === 0) {
          refusal(() => repoB.update(where, made.uuid, 1, { assumptions: [{ key: 'tab B' }] }), 'not-owner')
        }

        return value
      }

      const edited = repoA.update(where, made.uuid, 1, { assumptions: [{ key: 'tab A' }] })

      storage.getItem = read
      assert.ok(reads > 0)
      assert.equal(edited.revision, 2)
      assert.deepEqual(repoB.read(where, made.uuid).record.assumptions, [{ key: 'tab A' }])

      // the other tab takes the file over when the writer gives it up, and the one that gave it up reads
      tabA.release('cweb')
      assert.equal(await repoB.writable('cweb', 200), true)
      assert.equal(repoB.update(where, made.uuid, 2, { assumptions: [{ key: 'tab B' }] }).revision, 3)
      refusal(() => repoA.update(where, made.uuid, 3, { assumptions: [] }), 'not-owner')
      assert.equal(repoA.list(where)[0].record.revision, 3)
      assert.equal(repoB.clone(where, made.uuid).revision, 1)
      assert.equal(repoB.list(scope('cweb', 8)).length, 0)

      storage.items.set(key, JSON.stringify({ version: m.records.FILE_VERSION + 1, records: {} }))
      refusal(() => repoB.list(where), 'newer-version')
    } finally {
      delete globalThis.localStorage
    }
  })

  check('wiring', 'a browser with no Web Locks writes nothing and still reads', async () => {
    const storage = fakeLocalStorage()

    globalThis.localStorage = storage

    try {
      const repository = m.records.createRepository({ storage: m.records.createScenarioStorage({ Store: m.Shim, locks: null }), adapters: adapters(m) })
      const where = scope('cweb', 7)

      assert.equal(await repository.writable('cweb', 20), false)
      assert.match(refusal(() => design(repository, where), 'not-owner').message, /Web Locks/)
      assert.deepEqual(repository.list(where), [])
      assert.equal(storage.items.size, 0)
    } finally {
      delete globalThis.localStorage
    }
  })

  check('wiring', 'an attached source whose file cannot be read in web mode is refused by name beside the healthy sources, which are still listed', async () => {
    const storage = fakeLocalStorage()
    const locks = fakeLocks()

    globalThis.localStorage = storage

    try {
      const repository = m.records.createRepository({ storage: m.records.createScenarioStorage({ Store: m.Shim, locks }), adapters: adapters(m) })
      const where = scope('cweb', 7)

      storage.items.set('aurora-electrons:history/campaigns', JSON.stringify({ campaigns: { cweb: campaignEntry('cweb'), good: campaignEntry('good', { campaignId: 'cweb', branchId: 'b1', at: 1 }), bad: campaignEntry('bad', { campaignId: 'cweb', branchId: 'b1', at: 2 }) } }))
      assert.equal(await repository.writable('good', 200), true)
      assert.equal(await repository.writable('bad', 200), true)

      const healthy = note(repository, scope('good', 7))

      note(repository, scope('bad', 7))

      const key = 'aurora-electrons:scenarios/campaign-bad'

      ;[['{broken', 'unreadable'], ['null', 'damaged']].forEach(([raw, code]) => {
        storage.items.set(key, raw)

        const listed = repository.listAttached(where)

        assert.deepEqual(listed.entries.map((entry) => entry.record.uuid), [healthy.uuid])
        assert.deepEqual(listed.refused.map((entry) => [entry.campaignId, entry.code]), [['bad', code]])
        assert.equal(listed.refused[0].file, 'campaign-bad')
        assert.match(listed.refused[0].message, /bad/)
        assert.equal(storage.items.get(key), raw)
      })
    } finally {
      delete globalThis.localStorage
    }
  })

  return checks
}

// ---- Running ---------------------------------------------------------------------------------------------------------

// `only`: the starts of the names of the checks to run, or all of them. Each result is [group, name, true or what is wrong].
const runSuite = async (modules, only = null) => {
  const results = []

  for (const { group, name, run } of defineSuite(modules)) {
    if (only && !only.some((start) => name.startsWith(start))) {
      continue
    }

    try {
      await run()
      results.push([group, name, true])
    } catch (error) {
      results.push([group, name, String((error && error.stack) || error).split('\n').slice(0, 7).join('\n         ')])
    }
  }

  return results
}

// Each mutant breaks one rule of a copy of the module; the checks it names (by the start of their text) must fail there.
const MUTANTS = [
  { name: 'visibility ignores the race', find: 'record.campaignId === scope.campaignId && record.RaceID === scope.RaceID && (', replace: 'record.campaignId === scope.campaignId && (', fails: ['a record is never found for another race', 'two adapters keep records'] },
  { name: 'a branch-policy record shows on every branch', find: "(record.association.policy === 'campaign' || record.association.branchId === scope.branchId)", replace: 'true', fails: ['a branch-policy record shows only on its branch'] },
  { name: 'a record made later than the open save is never ahead', find: "const status = record.base.gameTime > scope.gameTime ? 'ahead' : 'current'", replace: "const status = 'current'", fails: ['a record made later than the open save', 'a reload and a rewind that keep the same object'] },
  { name: 'a record of another branch is not flagged', find: "if (record.base.branchId !== scope.branchId) {\n      flags.push('other-branch')", replace: "if (false) {\n      flags.push('other-branch')", fails: ['a record made later than the open save'] },
  { name: 'a reused object ID is taken as the same object', find: "status: current === link.fingerprint ? 'linked' : 'changed', current }", replace: "status: 'linked', current }", fails: ['an object ID reused by a different object', 'a reload and a rewind that keep the same object'] },
  { name: 'a gone object is told from nothing', find: "if (row === null || row === undefined) {\n      return { ...copy(link), status: 'missing' }", replace: "if (false) {\n      return { ...copy(link), status: 'missing' }", fails: ['a link whose object is gone', 'a reload and a rewind that keep the same object'] },
  { name: 'a failed resolution is reported as linked', find: "const unknown = (reason) => record.links.map((link) => ({ ...copy(link), status: 'unknown', reason }))", replace: "const unknown = (reason) => record.links.map((link) => ({ ...copy(link), status: 'linked', reason }))", fails: ['a link that cannot be resolved is unknown'] },
  { name: 'a stale edit is accepted', find: 'if (record.revision !== expectedRevision) {\n      throw new RevisionConflict(copy(record), expectedRevision)\n    }\n\n    const keys', replace: 'const keys', fails: ['a stale edit is rejected', 'an edit that another window wrote under'] },
  { name: 'a conflict carries no stored record', find: 'throw new RevisionConflict(copy(record), expectedRevision)\n    }\n\n    const keys', replace: 'throw new RevisionConflict({ revision: record.revision }, expectedRevision)\n    }\n\n    const keys', fails: ['a stale edit is rejected', 'an explicit reconcile'] },
  { name: 'a reconcile applies over the stale revision', find: 'applyEdit(file, s, conflict.stored.uuid, conflict.stored.revision, patch,', replace: 'applyEdit(file, s, conflict.stored.uuid, conflict.expectedRevision, patch,', fails: ['an explicit reconcile'] },
  { name: 'an edit does not bump the revision', find: 'next.revision = record.revision + 1', replace: 'next.revision = record.revision', fails: ['a stale edit is rejected', 'an edit changes only the editable fields'] },
  { name: 'a precondition of a create is not run', find: 'if (precondition) {', replace: 'if (false) {', fails: ['a precondition of a create runs inside the write'] },
  { name: 'a precondition of a create runs on the first attempt of the write only', find: 'if (precondition) {', replace: 'if (precondition && !precondition.ran && (precondition.ran = true)) {', fails: ['a precondition of a create runs inside the write'] },
  { name: 'a precondition of a create reads the records of every kind', find: 'precondition(entriesOf(file, s, { kind: adapter.kind, context }))', replace: 'precondition(entriesOf(file, s, { context }))', fails: ['a precondition of a create runs inside the write'] },
  { name: 'the whole file is written without the compare-and-swap', find: 'storeOf(campaignId).update((stored) => {\n      const file = prepared(stored, campaignId)\n\n      outcome = work(file)\n\n      return file\n    })', replace: 'const file = prepared(storeOf(campaignId).store, campaignId)\n\n    outcome = work(file)\n    storeOf(campaignId).store = file', fails: ['an edit that another window wrote under', 'two store clients over one host'] },
  { name: 'a clone keeps its source\'s uuid', find: "uuid: freshId(file),\n          createdAt: stamp,\n          updatedAt: stamp,\n          revision: 1,\n          provenance: { via: 'clone'", replace: "uuid: source.uuid,\n          createdAt: stamp,\n          updatedAt: stamp,\n          revision: 1,\n          provenance: { via: 'clone'", fails: ['a clone has a new uuid'] },
  { name: 'a delete ignores the revision', find: 'if (record.revision !== expectedRevision) {\n          throw new RevisionConflict(copy(record), expectedRevision)', replace: 'if (false) {\n          throw new RevisionConflict(copy(record), expectedRevision)', fails: ['a delete names the revision', 'two store clients over one host'] },
  { name: 'an edit may change an immutable field', find: 'const foreign = keys.filter((key) => !EDITABLE.includes(key))', replace: 'const foreign = []', fails: ['an edit changes only the editable fields'] },
  { name: 'a payload change does not restamp the versions', find: 'next.versions = versionsOf(adapter, next.payload)', replace: 'void 0', fails: ['an edit changes only the editable fields', 'an older adapter schema is migrated'] },
  { name: 'the version-0 migration drops provenance', find: 'provenance: copy(old.provenance),', replace: "provenance: { via: 'created' },", fails: ['a version-0 file is migrated'] },
  { name: 'the version-0 migration widens a record to the whole campaign', find: "association: { policy: 'branch', branchId: old.branchId },", replace: "association: { policy: 'campaign', branchId: old.branchId },", fails: ['a version-0 file is migrated'] },
  { name: 'the version-0 migration rewrites the payload', find: 'payload: copy(old.payload),', replace: 'payload: { ...old.payload, migrated: true },', fails: ['a version-0 file is migrated'] },
  { name: 'a file of a newer version is read', find: 'if (stored.version > FILE_VERSION) {', replace: 'if (false) {', fails: ['a file of a newer version is refused'] },
  { name: 'a file without a version is read', find: 'if (!Number.isInteger(stored.version) || stored.version < 0) {', replace: 'if (false) {', fails: ['a damaged file is refused'] },
  { name: 'a record of a damaged file is not checked', find: 'const problems = recordProblems(record, key, campaignId)\n\n    if (problems.length) {', replace: 'const problems = []\n\n    if (problems.length) {', fails: ['a damaged file is refused', 'a file kept under another campaign'] },
  { name: 'an older adapter schema is not migrated for the view', find: 'if (record.schema < adapter.schema) {\n          payload = copy(adapter.migrate(copy(record.payload), record.schema))\n        }', replace: 'void 0', fails: ['an older adapter schema is migrated'] },
  { name: 'a record of a newer schema can be edited', find: "if (record.schema > adapter.schema) {\n      throw refuse('unsupported-schema'", replace: "if (false) {\n      throw refuse('unsupported-schema'", fails: ['a record of a newer schema or of an unknown kind'] },
  { name: 'the adapter\'s refusal of a payload is ignored', find: 'const problems = problemsOf(adapter, payload)\n\n  if (problems.length) {', replace: 'const problems = []\n\n  if (problems.length) {', fails: ['an adapter that rejects a payload is obeyed'] },
  { name: 'a payload that is not JSON is accepted', find: "if (!isObject(payload) || !isJson(payload)) {\n    throw refuse('invalid-payload'", replace: "if (false) {\n    throw refuse('invalid-payload'", fails: ['an adapter that rejects a payload is obeyed'] },
  { name: 'a failing validation is read as valid', find: 'return [`the validation failed (', replace: 'return [] || [`the validation failed (', fails: ['an adapter whose validation throws'] },
  { name: 'an import does not need a target', find: 'if (!isObject(target) || !isSegment(target.campaignId) || !Number.isInteger(target.RaceID) || !isText(target.branch)) {', replace: 'if (false) {', fails: ['an import without an explicit target'] },
  { name: 'an import does not need a preview', find: "if (!isObject(preview) || typeof preview.digest !== 'string') {", replace: 'if (false) {', fails: ['an import is made from the preview'] },
  { name: 'an import is not tied to the previewed bundle and target', find: 'if (preview.digest !== digestOf(importKey(b, t, keepUuids, restore))) {', replace: 'if (false) {', fails: ['an import is made from the preview'] },
  { name: 'an imported record keeps its uuid', find: 'const uuid = item.keepsUuid ? record.uuid : freshId(file)', replace: 'const uuid = record.uuid', fails: ['an imported record takes a new uuid', 'keeping uuids is explicit'] },
  { name: 'a kept uuid overwrites a colliding record', find: 'keepsUuid: (!!keepUuids || restore) && !collides && !tombstoned,', replace: 'keepsUuid: (!!keepUuids || restore) && !tombstoned,', fails: ['keeping uuids is explicit'] },
  { name: 'an imported record keeps its source campaign and race', find: 'campaignId: target.campaignId,\n    RaceID: target.RaceID,\n    association: { policy: record.association.policy, branchId: target.branch },', replace: 'campaignId: record.campaignId,\n    RaceID: record.RaceID,\n    association: { policy: record.association.policy, branchId: target.branch },', fails: ['an imported record takes a new uuid'] },
  { name: 'an imported record keeps its source branch', find: 'association: { policy: record.association.policy, branchId: target.branch },', replace: 'association: copy(record.association),', fails: ['an imported record takes a new uuid'] },
  { name: 'an import does not ask the adapter', find: 'reasons.push(...problemsOf(adapter, payload).map((problem) =>', replace: 'reasons.push(...[].map((problem) =>', fails: ['an import never takes a record its adapter rejects'] },
  { name: 'an import takes a record of a newer schema', find: 'else if (record.schema > adapter.schema) {\n          reasons.push(', replace: 'else if (false) {\n          reasons.push(', fails: ['an import never takes a record its adapter rejects'] },
  { name: 'an import takes an unknown kind', find: 'if (!adapter) {\n          reasons.push(', replace: 'if (false) {\n          reasons.push(', fails: ['an import never takes a record its adapter rejects'] },
  { name: 'an export reaches the records of other races and branches', find: '.filter((record) => visible(record, s) && (!wanted', replace: '.filter((record) => (!wanted', fails: ['an export carries the visible records'] },
  { name: 'every campaign shares one file', find: 'const name = scenarioFileName(campaignId)\n\n      if (!stores[name]) {', replace: "const name = 'campaign-shared'\n\n      if (!stores[name]) {", fails: ['the factory opens one file per campaign'] },
  { name: 'an unsafe campaign id names a file', find: "if (!isSegment(campaignId)) {\n    throw refuse('invalid-scope', 'A campaign id is letters, digits, hyphens and underscores')\n  }", replace: 'void 0', fails: ['an unsafe campaign id'] },
  { name: 'a deleted uuid leaves no tombstone', find: 'define(file.tombstones, uuid, { revision: record.revision, deletedAt: now() })\n        ', replace: '', fails: ['a deleted uuid leaves a tombstone', 'an edit prepared before its record was deleted'] },
  { name: 'an import keeps the uuid of a tombstone', find: 'keepsUuid: (!!keepUuids || restore) && !collides && !tombstoned,', replace: 'keepsUuid: (!!keepUuids || restore) && !collides,', fails: ['a deleted uuid leaves a tombstone', 'an edit prepared before its record was deleted'] },
  { name: 'a restore copies a record the file holds', find: "status: reasons.length ? 'rejected' : restore && (collides || tombstoned) ? 'skipped' : 'import',", replace: "status: reasons.length ? 'rejected' : 'import',", fails: ['a restore of records'] },
  { name: 'a restore gives a record a new uuid', find: 'keepsUuid: (!!keepUuids || restore) && !collides && !tombstoned,', replace: 'keepsUuid: !!keepUuids && !collides && !tombstoned,', fails: ['a restore of records'] },
  { name: 'a restore decides what is stored before the import', find: 'const plan = planImport(file, b, t, keepUuids, restore)\n        const stamp', replace: 'const plan = planImport({ records: {}, tombstones: {} }, b, t, keepUuids, restore)\n        const stamp', fails: ['a restore of records'] },
  { name: 'a restore preview is not tied to its policy', find: 'restore ? [bundle, target, !!keepUuids, \'restore\'] : [bundle, target, !!keepUuids]', replace: '[bundle, target, !!keepUuids]', fails: ['a restore of records'] },
  { name: 'a write needs no owner', find: "if (!claim || claim.state !== 'owner') {\n              throw refusal(campaignId, claim)\n            }", replace: 'if (false) {\n              throw refusal(campaignId, claim)\n            }', fails: ['two tabs of web mode', 'a browser with no Web Locks'] },
  { name: 'a browser with no Web Locks owns its file', find: "state: locks ? 'waiting' : 'unavailable'", replace: "state: locks ? 'waiting' : 'owner'", fails: ['a browser with no Web Locks'] },
  { name: 'a tab that released its file keeps writing', find: "claims.delete(name)\n        claim.state = 'released'\n        claim.free()", replace: 'claim.free()', fails: ['two tabs of web mode'] },
  { name: 'web mode is not marked as needing a write owner', file: 'scripts/web/shims/electron-store.js', find: 'Store.writesNeedOwner = true', replace: 'Store.writesNeedOwner = false', fails: ['two tabs of web mode'] },
  { name: 'a damaged browser storage entry is read as empty', file: 'scripts/web/shims/electron-store.js', find: '    return strict ? parsed : (parsed || {})\n  } catch (e) {\n    if (strict) {', replace: '    return strict ? parsed : (parsed || {})\n  } catch (e) {\n    if (false) {', fails: ['a malformed browser storage entry'] },
  { name: 'a browser storage entry of null, false or 0 is read as empty', file: 'scripts/web/shims/electron-store.js', find: 'return strict ? parsed : (parsed || {})', replace: 'return parsed || {}', fails: ['a browser storage entry that parses to null'] },
  { name: 'every browser store reads strictly', file: 'scripts/web/shims/electron-store.js', find: 'this.strict = options.strict === true', replace: 'this.strict = true', fails: ['the web shim reads an ordinary store as empty'] },
  { name: 'a scenario file is opened without asking for a strict read', find: 'new Store({ cwd: SCENARIO_FOLDER, name, strict: true })', replace: 'new Store({ cwd: SCENARIO_FOLDER, name })', fails: ['a malformed browser storage entry', 'a browser storage entry that parses to null'] },
  { name: 'the campaign registry is opened without asking for a strict read', find: 'new Store({ cwd: REGISTRY_FOLDER, name: REGISTRY_NAME, strict: true })', replace: 'new Store({ cwd: REGISTRY_FOLDER, name: REGISTRY_NAME })', fails: ['a malformed browser storage entry'] },
  { name: 'a source file that cannot be read stops the whole listing', find: "refused.push({ campaignId: source, file: scenarioFileName(source), code: error instanceof RecordsRefused ? error.code : 'unreadable',", replace: 'if (!(error instanceof RecordsRefused)) {\n            throw error\n          }\n\n          refused.push({ campaignId: source, file: scenarioFileName(source), code: error.code,', fails: ['an attached source whose file cannot be read in web mode'] },
  { name: 'a record of any merged campaign is attached', find: 'campaigns[id].mergedInto && endOf(id) === campaignId)', replace: 'campaigns[id].mergedInto)', fails: ['records of a campaign attached'] },
  { name: 'an adopted record keeps the source uuid', find: "const stored = materialized(entry, target, stamp, freshId(file), { via: 'adopt'", replace: "const stored = materialized(entry, target, stamp, uuid, { via: 'adopt'", fails: ['records of a campaign attached'] },
  { name: 'a record is adopted twice', find: 'if (adopted) {', replace: 'if (false) {', fails: ['records of a campaign attached'] },
  { name: 'a record of another race is adopted', find: 'has(source.records, uuid) && source.records[uuid].RaceID === s.RaceID ?', replace: 'has(source.records, uuid) ?', fails: ['records of a campaign attached'] },
  { name: 'an attached record is not flagged', find: "entry.flags.push('attached-campaign')", replace: 'void 0', fails: ['records of a campaign attached'] },
  { name: 'a registry the campaign module refuses is trusted', find: 'stored = storage.registry()\n      readRegistry({ registry: { store: stored } })', replace: 'stored = storage.registry()', fails: ['records of a campaign attached'] },
  { name: 'a uuid is any path-safe text', find: "const isUuid = (value) => typeof value === 'string' && UUID.test(value)", replace: "const isUuid = (value) => typeof value === 'string' && SEGMENT.test(value)", fails: ['a damaged file is refused', 'a bundle record whose uuid'] },
  { name: 'a null save resolves the links', find: 'context === undefined || context === null ? undefined :', replace: 'context === undefined ? undefined :', fails: ['a link that cannot be resolved is unknown'] },
]

// The module, the store host and client and the web shim copied, with one mutant applied, to the layout the loader reads: `<root>/src/...` and `<root>/scripts/web/shims/...`. The mutant's `file` is relative to the root.
const MODULE_FILE = 'src/renderer/utilities/scenario-records.js'

const mutatedTree = (mutant) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-scenario-mutant-'))
  const files = [MODULE_FILE, 'src/renderer/utilities/campaign.js', 'src/main/store-host.js', 'src/preload/store-client.js', 'scripts/web/shims/electron-store.js']

  files.forEach((file) => {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
    fs.copyFileSync(path.join(repo, file), path.join(directory, file))
  })

  if (mutant) {
    const target = path.join(directory, mutant.file || MODULE_FILE)
    const source = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')

    if (source.split(mutant.find).length !== 2) {
      fs.rmSync(directory, { recursive: true, force: true })
      throw new Error(`The mutant "${mutant.name}" does not apply exactly once`)
    }

    fs.writeFileSync(target, source.replace(mutant.find, () => mutant.replace))
  }

  return directory
}

// The checks `only` names of one tree, run in a Node process of its own (the repository's registry of adapters is module state, and a mutant must not leak into the next tree).
const checksInChild = (tree, only) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [__filename], { env: { ...process.env, SCENARIO_TREE: tree, SCENARIO_ONLY: JSON.stringify(only) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let errors = ''

  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { errors += chunk })
  child.on('error', reject)
  child.on('close', (code) => {
    const line = out.split('\n').find((row) => row.startsWith(RESULT_PREFIX))

    if (code !== 0 || !line) {
      reject(new Error(`The checks of ${tree} ended with ${code}: ${errors.trim().slice(0, 400)}`))
    } else {
      resolve(JSON.parse(line.slice(RESULT_PREFIX.length)))
    }
  })
})

const tryMutant = async (mutant) => {
  let directory

  try {
    directory = mutatedTree(mutant)

    const results = await checksInChild(path.join(directory, 'src'), mutant.fails)
    const survived = mutant.fails.filter((start) => !results.some(([, name, result]) => name.startsWith(start) && result !== true))
    const missing = mutant.fails.filter((start) => !results.some(([, name]) => name.startsWith(start)))

    return [`mutant caught: ${mutant.name} (fails: ${mutant.fails.join('; ')})`, survived.length === 0 && missing.length === 0 ? true : `${missing.length ? `no check starts with: ${missing.join('; ')}. ` : ''}${survived.length ? `these checks still pass: ${survived.join('; ')}` : ''}`]
  } catch (error) {
    return [`mutant caught: ${mutant.name}`, error.message]
  } finally {
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

const controlOf = async () => {
  let directory = null

  try {
    directory = mutatedTree(null)

    return await checksInChild(path.join(directory, 'src'), [...new Set(MUTANTS.flatMap((mutant) => mutant.fails))])
  } catch (error) {
    return error
  } finally {
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

const main = async () => {
  if (process.env.SCENARIO_TREE) {
    const results = await runSuite(await loadModules(process.env.SCENARIO_TREE), JSON.parse(process.env.SCENARIO_ONLY))

    console.log(RESULT_PREFIX + JSON.stringify(results))
    process.exit(0)
  }

  const mutating = !process.argv.includes('--no-mutations')

  // The unchanged tree, in this process, the mutants and the control, each in a process of its own, all sharing the CHECK_JOBS places.
  const [results, ...rest] = await inParallel([null, ...(mutating ? [...MUTANTS, 'control'] : [])], async (item) => (item === null ? runSuite(await loadModules(src)) : item === 'control' ? controlOf() : tryMutant(item)))
  let group = null
  let failed = 0
  let total = 0
  const show = (name, result) => {
    total++

    if (result === true) {
      console.log(`  ok     ${name}`)
    } else {
      failed++
      console.log(`  FAIL   ${name}\n         ${result}`)
    }
  }

  if (results instanceof Error) {
    throw results
  }

  results.forEach(([next, name, result]) => {
    if (next !== group) {
      group = next
      console.log(`\n${group}`)
    }

    show(name, result)
  })

  if (mutating) {
    console.log('\nmutants')

    for (const [name, result] of rest.slice(0, MUTANTS.length)) {
      show(name, result)
    }

    const control = rest[MUTANTS.length]
    const wrong = control instanceof Error ? [control.message] : control.filter(([, , result]) => result !== true).map(([, name]) => name)

    show('a control run of the unchanged copy passes every check the mutants name', wrong.length === 0 && !(control instanceof Error) ? true : `fails ${wrong.join('; ')}`)
  }

  console.log(`\n${total - failed} of ${total} checks passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
