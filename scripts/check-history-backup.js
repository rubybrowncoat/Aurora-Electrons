/*
  Checks the backup and restore of Empire History (utilities/history-backup.js): the envelope a backup is written as, what a file must pass before it is previewed, the plan and the restore with a policy per target, and what is never overwritten.

  node scripts/check-history-backup.js [--no-mutations]

  Everything runs on in-memory installations (each store a JSON value read and written whole, with the store client's compare-and-swap `update`, and a mirror of every write in a temporary folder so byte-identity is checked on files too), on the real scenario repository over such a store for the annotations, and on recorded history of the passive campaign of artifacts/passive-campaign-20261013 (read only, skipped when it is not here). No Electron and no network are needed; a save is only opened read only, and its checksum is compared with the one recorded for it before and after.

  Groups:
  - round trip: a real recorded campaign and a synthetic one with branches, intelligence and annotations come back exactly (series with their scope, units and coverage), newer metadata is kept, and the save's checksum is unchanged;
  - preview: the counts and the policy of each target are shown before anything is written, and a cancel leaves every file byte-identical;
  - rejection: a malformed, altered, oversized or future-schema file is refused with nothing previewed or truncated;
  - association: an answer, a merge mark or a pending question is never overwritten, a campaign of another galaxy is refused, a campaign of another id that shares a game id is kept apart, and a timeline that is not the stored one is never merged into it;
  - policy: merge, replace and keep per target, with a choice of races;
  - apply: a backup of the current files comes first, a stale plan, a tab that does not record and a backup that cannot be kept all stop it with nothing written, and it can be run again;
  - annotations: a record is restored once, never over a stored one and never when it was deleted.

  Mutants: each of a list of deliberate faults in one module is run, with the checks it names, in a Node process of its own that loads that module from the faulted text and every other from the sources; it is caught when each named check fails there. A control run of the unchanged sources must pass every check the mutants name. The checks of the sources, the control run and the mutants run side by side. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const assert = require('./lib/bounded-assert')
const { loadUtilities } = require('./lib/utilities')
const { inParallel } = require('./lib/check-pool')

const repo = path.resolve(__dirname, '..')
const src = path.join(repo, 'src')
const RESULT_PREFIX = 'HISTORY-BACKUP-RESULT '
const MODULE_FILE = 'src/renderer/utilities/history-backup.js'

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

const loadModules = async (base, sources = {}) => {
  const names = ['history-backup', 'campaign', 'history', 'scenario-records', 'recording-owner', 'colony-series', 'event-archive'].map((name) => `renderer/utilities/${name}`)
  const loaded = await loadUtilities(names, { stubs: STUBS, directory: base, sources })

  return { backup: loaded[names[0]], campaign: loaded[names[1]], history: loaded[names[2]], records: loaded[names[3]], owner: loaded[names[4]], colony: loaded[names[5]], events: loaded[names[6]] }
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// ---- Installations ----------------------------------------------------------------------------------------------------

// The stores of one installation: each a JSON value read and written whole, as electron-store's `.store` is, with the store client's whole-file `update`. Each is kept as its JSON text and parsed on every read, which gives the copy a read must be (one pass over the value, not the two of a clone) and lets `snapshot` join the texts without stringifying the values again. `dir` mirrors every write as a file, so a check can compare the bytes of the installation before and after. `hooks.beforeWrite(name, index)` can throw to stand for a full disk.
const installation = ({ dir = null, first = 1 } = {}) => {
  const texts = new Map()
  const read = (name) => (texts.get(name) === undefined ? undefined : JSON.parse(texts.get(name)))
  const files = { get: read, has: (name) => texts.has(name), forEach: (visit) => texts.forEach((_text, name) => visit(read(name), name)) }
  const writes = []
  const hooks = { beforeWrite: null }
  const put = (name, value) => {
    const text = JSON.stringify(value)

    texts.set(name, text)

    if (dir) {
      fs.writeFileSync(path.join(dir, `${encodeURIComponent(name)}.json`), text)
    }
  }
  const store = (name) => ({
    get store () {
      return read(name) || {}
    },
    set store (value) {
      if (hooks.beforeWrite) {
        hooks.beforeWrite(name, writes.length)
      }

      put(name, value)
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
  let counter = first * 1000
  let clock = 1000000 * first
  const inst = {
    files,
    writes,
    hooks,
    put,
    store,
    newId: () => `c${++counter}`,
    now: () => ++clock,
    io: { registry: store('registry'), migration: store('migration'), settings: store('settings'), backup: store('backup'), file: (name) => store(`file:${name}`) },
    snapshot: () => `[${[...texts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, text]) => `[${JSON.stringify(name)},${text === undefined ? 'null' : text}]`).join(',')}]`,
    bytes: () => {
      const hash = crypto.createHash('sha256')

      fs.readdirSync(dir).sort().forEach((name) => hash.update(name).update(fs.readFileSync(path.join(dir, name))))

      return hash.digest('hex')
    },
    registry: () => ({ campaigns: {}, pool: {}, ...(read('registry') || {}) }),
    fileOf: (campaignId, branchId = 'b1') => read(`file:campaign-${campaignId}-${branchId}`) || {},
  }

  return inst
}

// ---- The suite --------------------------------------------------------------------------------------------------------

const defineSuite = (m) => {
  const checks = []
  const check = (group, name, run) => checks.push({ group, name, run })
  const { backup, campaign, records, history, colony, events } = m

  const anchorRows = (key, count = 10) => Array.from({ length: count }, (_, index) => [100 + index, index + 1, Number((1 + key / 100 + index / 1000).toFixed(4)), 1, 1, 1, 1])
  const ledger = (n, salt = 0) => Array.from({ length: n }, (_, index) => ({ IncrementID: index + 1, GameTime: (index + 1) * 5 + salt }))
  const tipOf = (n, salt = 0) => {
    const scan = campaign.scanLedger(ledger(n, salt))

    return { n: scan.count, t: n ? n * 5 + salt : null, digest: scan.digest, checkpoints: scan.checkpoints, early: scan.early }
  }

  const entryOf = ({ id, name = 'Campaign', GameID = 1, key = 1, branches = { b1: tipOf(100) }, attachments = [], createdAt = 100, seen = 200, extra = {} }) => ({
    id,
    provenance: { via: 'recorded' },
    createdAt,
    seen,
    names: [{ name, t: 5, seen: createdAt }],
    gameIds: [GameID],
    anchor: anchorRows(key),
    branchSeq: Math.max(...Object.keys(branches).map((branchId) => Number(branchId.slice(1)))),
    branches: Object.fromEntries(Object.entries(branches).map(([branchId, tip]) => [branchId, { id: branchId, parent: branchId === 'b1' ? null : 'b1', fork: branchId === 'b1' ? null : { n: 64, digest: 'fork', t: 320 }, createdAt, seen, tip }])),
    attachments,
    legacy: null,
    ...extra,
  })

  const snapshot = (t, extra = {}) => ({ t, population: t / 10, colonies: 3, wealth: 100, income: 5, fuel: 1000, msp: 10, minerals: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], militaryShips: 2, militaryTons: 4000, commercialShips: 1, commercialTons: 1000, installations: { 1: 5, 7: null }, research: 5000, systems: 8, commanders: 4, ...extra })

  const intelSnapshot = (t, extra = {}) => ({ t, contact: 1, comm: 2, translation: 0.5, points: 100, intel: 3, granted: 1, received: 0, ships: 4, tons: 8000, lost: 0, classes: 2, populations: 1, population: 12.5, systems: 3, ground: 0, sensors: 1, ...extra })

  // A history file: `races` is { [RaceID]: { raceName, times, over: { [t]: extra figures } } }, `intel` { [View]: { [Alien]: { name, times } } }.
  const fileOf = ({ gameName = 'Campaign', races = {}, intel = {} }) => ({
    gameName,
    races: Object.fromEntries(Object.entries(races).map(([RaceID, { raceName = 'Terran', npr = false, times, over = {} }]) => [RaceID, { raceName, npr, snapshots: times.map((t) => snapshot(t, over[t] || {})) }])),
    intel: Object.fromEntries(Object.entries(intel).map(([view, aliens]) => [view, Object.fromEntries(Object.entries(aliens).map(([alien, { name = 'Alien', times, over = {} }]) => [alien, { name, snapshots: times.map((t) => intelSnapshot(t, over[t] || {})) }]))])),
  })

  const seed = (inst, { entries = [], files = {}, pool = {} }) => {
    inst.put('registry', { version: 1, campaigns: Object.fromEntries(entries.map((entry) => [entry.id, entry])), pool })
    Object.entries(files).forEach(([name, file]) => inst.put(`file:campaign-${name}`, file))
  }

  const exportOf = (inst, { ids = null, annotations = null, at = 9000 } = {}) => backup.buildBackup(inst.io, { campaignIds: ids, at, annotations })

  const textOf = (envelope) => JSON.stringify(envelope)

  const parsed = (envelope) => {
    const out = backup.parseBackup(textOf(envelope))

    assert.equal(out.errors, undefined, out.errors && out.errors[0])

    return out.envelope
  }

  const plan = (inst, envelope, choices = {}, annotations = null) => backup.planRestore({ io: inst.io, envelope, choices, annotations })

  const restore = async (inst, envelope, choices = {}, { annotations = null, confirmed = true, expected } = {}) => {
    const planned = plan(inst, envelope, choices, annotations)

    return { planned, result: await backup.applyRestore({ io: inst.io, envelope, choices, expected: expected === undefined ? planned.digest : expected, confirmed, now: inst.now, annotations }) }
  }

  const rejects = async (work, name) => {
    let error = null

    try {
      await work()
    } catch (thrown) {
      error = thrown
    }

    assert.ok(error, `it should have been refused with ${name}`)
    assert.equal(error.name, name, error.stack)

    return error
  }

  const timesOf = (file, RaceID = 1) => (file.races && file.races[RaceID] ? file.races[RaceID].snapshots.map((item) => item.t) : [])

  // The seal of a backup text whose campaigns were edited as text: the digest made again, so a check of a field is not stopped by the digest.
  const sealed = (text) => {
    const doc = JSON.parse(text)

    return text.replace(`"digest":"${doc.digest}"`, `"digest":"${campaign.hashValue(doc.campaigns)}"`)
  }

  const withDir = async (work) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-history-backup-'))

    try {
      return await work(dir)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  // A stored installation holding campaign c1 (branches b1 and b2), and the same campaign as another installation recorded it.
  const pair = () => {
    const stored = installation()
    const other = installation({ first: 2 })
    const entry = entryOf({ id: 'c1', branches: { b1: tipOf(100), b2: tipOf(100) } })

    seed(stored, { entries: [entry], files: { 'c1-b1': fileOf({ races: { 1: { raceName: 'Old name', times: [100, 200, 300], over: { 200: { population: 999 } } }, 2: { times: [100] } }, intel: { 1: { 2: { name: 'Alien', times: [100] } } } }), 'c1-b2': fileOf({ races: { 1: { times: [100, 200] } } }) } })
    seed(other, { entries: [clone(entry)], files: { 'c1-b1': fileOf({ races: { 1: { raceName: 'Renamed', times: [200, 300, 400, 500] }, 2: { times: [150] } }, intel: { 1: { 2: { name: 'Alien II', times: [100, 600] } } } }), 'c1-b2': fileOf({ races: { 1: { times: [200, 250] } } }) } })

    return { stored, other, entry }
  }

  // ---- round trip ----

  check('round trip', 'a real recorded campaign comes back exactly, series by scope with their units, and the save\'s checksum is unchanged', async () => {
    const real = await realSaves(m, [1, 2, 3, 40, 80, 150])

    if (!real) {
      return
    }

    try {
      const a = installation()
      const b = installation({ first: 2 })

      await real.record(a, real.picks)

      assert.equal(Object.keys(a.registry().campaigns).length, 1)

      const [id] = Object.keys(a.registry().campaigns)
      const envelope = parsed(exportOf(a))
      const file = envelope.campaigns[0].branches.b1

      assert.ok(Object.keys(file.races).length >= 2, 'the player race and an NPR are recorded')
      assert.ok(Object.values(file.races).every((series) => series.snapshots.length === real.picks.length && series.coverage.count === real.picks.length))
      assert.ok(file.intel && typeof file.intel === 'object' && Object.values(file.intel).every((aliens) => Object.values(aliens).every((series) => series.coverage.count === series.snapshots.length)), 'intelligence series, when recorded, carry their coverage')
      assert.equal(envelope.units.race.population, 'million people')
      assert.equal(envelope.units.intelligence.points, 'diplomatic points')

      await restore(b, envelope)

      assert.deepEqual(b.fileOf(id), a.fileOf(id))
      assert.deepEqual(b.registry().campaigns[id], a.registry().campaigns[id])
      assert.deepEqual(parsed(exportOf(b)).campaigns, envelope.campaigns)
      assert.deepEqual(await real.checksums(), real.expected)
    } finally {
      real.close()
    }
  })

  check('round trip', 'a real recorded history merged into an older one of the same campaign keeps the newer metadata and adds only what is new', async () => {
    const real = await realSaves(m, [1, 2, 3, 40, 80, 150])

    if (!real) {
      return
    }

    try {
      const a = installation()
      const b = installation({ first: 2 })

      await real.record(a, real.picks)

      const [id] = Object.keys(a.registry().campaigns)

      // The older installation recorded the first saves of the campaign under the id the newer one holds.
      b.newId = () => id

      await real.record(b, real.picks.slice(0, 3))

      const older = b.registry().campaigns[id]
      const unproven = plan(b, parsed(exportOf(a))).preview.campaigns[0].files[0]

      // The real tips end between checkpoints, where no digest covers the whole of the older one: whether one continues the other is not known, so the branch is kept as it is.
      assert.notEqual(older.branches.b1.tip.n % 64, 0)
      assert.equal(unproven.relation, 'unknown')
      assert.equal(unproven.policy, 'keep')

      // The older installation stopped at a checkpoint: the newer tip holds the digest of the whole of it.
      const registry = b.registry()
      const stopped = a.registry().campaigns[id].branches.b1.tip
      const count = Math.floor(older.branches.b1.tip.n / 64) * 64

      registry.campaigns[id].branches.b1.tip = { n: count, t: older.branches.b1.tip.t, digest: stopped.checkpoints[count / 64 - 1], checkpoints: stopped.checkpoints.slice(0, count / 64), early: older.branches.b1.tip.early }
      b.put('registry', registry)

      const planned = plan(b, parsed(exportOf(a)))
      const view = planned.preview.campaigns[0]
      const row = view.files[0]

      assert.equal(view.status, 'known')
      assert.equal(row.policy, 'merge')
      assert.equal(row.relation, 'extends')
      assert.ok(row.totals.added > 0 && row.totals.identical > 0 && row.totals.conflicts === 0, JSON.stringify(row.totals))

      await restore(b, parsed(exportOf(a)))

      assert.deepEqual(b.fileOf(id), a.fileOf(id))
      assert.deepEqual(b.registry().campaigns[id].branches.b1.tip, a.registry().campaigns[id].branches.b1.tip)
      assert.ok(b.registry().campaigns[id].branches.b1.tip.n > count)
      assert.equal(b.registry().campaigns[id].createdAt, Math.min(older.createdAt, a.registry().campaigns[id].createdAt))
      assert.equal(b.registry().campaigns[id].seen, Math.max(older.seen, a.registry().campaigns[id].seen))

      const newer = installation({ first: 1 })

      newer.newId = () => id
      await real.record(newer, real.picks.slice(0, 3))

      const before = a.snapshot()
      const { result } = await restore(a, parsed(exportOf(newer)))

      assert.equal(result.applied, false, 'an older backup adds nothing to a newer history')
      assert.equal(a.snapshot(), before)
    } finally {
      real.close()
    }
  })

  check('round trip', 'a campaign with branches, intelligence and annotations round-trips into an empty installation with every scope, unit and uuid kept', async () => {
    const world = annotated()
    const envelope = parsed(exportOf(world.a, { annotations: world.annotationsA }))
    const b = installation({ first: 2 })

    assert.equal(envelope.campaigns[0].annotations.length, 3)
    assert.deepEqual(Object.keys(envelope.campaigns[0].branches), ['b1', 'b2'])
    assert.equal(envelope.campaigns[0].branches.b1.intel[1][2].coverage.count, 2)

    const { result } = await restore(b, envelope, {}, { annotations: world.annotationsB(b) })

    assert.equal(result.applied, true)
    assert.equal(result.backup, null, 'nothing existed to back up')
    assert.deepEqual(b.fileOf('c1', 'b1'), world.a.fileOf('c1', 'b1'))
    assert.deepEqual(b.fileOf('c1', 'b2'), world.a.fileOf('c1', 'b2'))
    assert.deepEqual(b.registry().campaigns.c1, world.a.registry().campaigns.c1)

    const repoB = world.repositoryB(b)

    assert.deepEqual(repoB.list(world.scope(1, 'b1')).map((entry) => entry.record.uuid).sort(), world.notes.filter((note) => note.RaceID === 1 && note.branch === 'b1').map((note) => note.uuid).sort())
    assert.equal(repoB.read(world.scope(1, 'b1'), world.notes[0].uuid).record.provenance.via, 'import')
    assert.deepEqual(parsed(exportOf(b, { annotations: world.annotationsB(b) })).campaigns[0].branches, envelope.campaigns[0].branches)
  })

  // ---- preview ----

  check('preview', 'a preview shows the policy and the counts of stored, backup, added, identical and conflicting snapshots of each target and writes nothing', async () => {
    const { stored, other } = pair()
    const envelope = parsed(exportOf(other))
    const before = stored.snapshot()
    const planned = plan(stored, envelope, { campaigns: { c1: { files: { b1: { policy: 'merge' }, b2: { policy: 'replace' } } } } })
    const [campaignView] = planned.preview.campaigns
    const b1 = campaignView.files.find((file) => file.branchId === 'b1')
    const race1 = b1.series.find((row) => row.key === 'race:1')

    assert.equal(planned.preview.campaigns.length, 1)
    assert.equal(b1.policy, 'merge')
    assert.deepEqual({ stored: race1.stored, backup: race1.backup, added: race1.added, identical: race1.identical, conflicts: race1.conflicts, result: race1.result }, { stored: 3, backup: 4, added: 2, identical: 1, conflicts: 1, result: 5 })
    assert.equal(campaignView.files.find((file) => file.branchId === 'b2').policy, 'replace')
    assert.equal(stored.writes.length, 0)
    assert.equal(stored.snapshot(), before)
  })

  check('preview', 'a stored snapshot at a shared game time stays under merge, and the backup\'s under replace, as the counts said', async () => {
    const merged = pair()
    const replaced = pair()

    await restore(merged.stored, parsed(exportOf(merged.other)))
    await restore(replaced.stored, parsed(exportOf(replaced.other)), { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } })

    const kept = merged.stored.fileOf('c1').races[1].snapshots.find((item) => item.t === 200)
    const overwritten = replaced.stored.fileOf('c1').races[1].snapshots.find((item) => item.t === 200)

    assert.equal(kept.population, 999)
    assert.equal(overwritten.population, 20)
    assert.deepEqual(timesOf(merged.stored.fileOf('c1')), [100, 200, 300, 400, 500])
    assert.deepEqual(timesOf(replaced.stored.fileOf('c1')), [200, 300, 400, 500])
  })

  check('preview', 'cancelling after a preview leaves every file of the installation byte-identical', async () => {
    await withDir(async (dir) => {
      const { stored, other } = pair()
      const live = installation({ dir })

      seed(live, { entries: [stored.registry().campaigns.c1], files: { 'c1-b1': stored.fileOf('c1', 'b1'), 'c1-b2': stored.fileOf('c1', 'b2') } })

      const bytes = live.bytes()
      const memory = live.snapshot()
      const envelope = parsed(exportOf(other))

      plan(live, envelope)
      plan(live, envelope, { campaigns: { c1: { files: { b1: { policy: 'replace' }, b2: { policy: 'keep' } } } } })

      assert.equal(live.writes.length, 0)
      assert.equal(live.bytes(), bytes)
      assert.equal(live.snapshot(), memory)
    })
  })

  check('preview', 'a replace that removes or overwrites stored snapshots needs a confirmation, and without it nothing is written', async () => {
    const { stored, other } = pair()
    const envelope = parsed(exportOf(other))
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } }
    const planned = plan(stored, envelope, choices)
    const before = stored.snapshot()

    assert.ok(planned.preview.needsConfirmation.length === 1 && /drops or overwrites 3 stored snapshots/.test(planned.preview.needsConfirmation[0]), planned.preview.needsConfirmation.join('|'))
    assert.deepEqual({ removed: planned.preview.totals.removed, conflicts: planned.preview.totals.conflicts }, { removed: 2, conflicts: 1 })

    await rejects(() => backup.applyRestore({ io: stored.io, envelope, choices, expected: planned.digest, confirmed: false, now: stored.now }), 'Rejected')
    assert.equal(stored.snapshot(), before)
    assert.equal(plan(stored, envelope).preview.needsConfirmation.length, 0, 'a merge needs none')
  })

  // ---- rejection ----

  const base = () => {
    const world = annotated()

    return { world, text: textOf(exportOf(world.a, { annotations: world.annotationsA })) }
  }

  const refused = (text, pattern) => {
    const out = backup.parseBackup(text)

    assert.equal(out.envelope, undefined, 'it was read')
    assert.ok(Array.isArray(out.errors) && out.errors.length === 1, JSON.stringify(out))
    assert.match(out.errors[0], pattern)
  }

  const edited = (change) => {
    const { text } = base()
    const doc = JSON.parse(text)

    change(doc)

    return sealed(JSON.stringify(doc).replace(`"digest":"${doc.digest}"`, `"digest":"${JSON.parse(text).digest}"`))
  }

  check('rejection', 'a file that is not JSON, not a history backup or without a version is refused', async () => {
    const { text } = base()

    refused('{', /not valid JSON/)
    refused(text.slice(0, text.length - 40), /not valid JSON/)
    refused('[]', /not a history backup/)
    refused(JSON.stringify({ format: 'aurora-scenario-records', version: 1 }), /not a history backup/)
    refused(edited((doc) => { doc.version = 0 }), /no version/)
    refused(edited((doc) => { doc.version = '1' }), /no version/)
    assert.equal(backup.parseBackup(5).errors.length, 1)
  })

  check('rejection', 'a file of a future schema is refused whole, whichever of the envelope, the campaign records or the annotations is newer', async () => {
    refused(edited((doc) => { doc.version = 4 }), /version 4, written by a newer version/)
    refused(edited((doc) => { doc.schemas.registry = 2 }), /campaign records of the backup are of version 2/)
    refused(edited((doc) => { doc.schemas.annotations = 2 }), /annotations of the backup are of version 2/)
    refused(edited((doc) => { doc.campaigns[0].annotations[0].version = 2 }), /annotations are of version 2/)
  })

  check('rejection', 'a game time that is not finite, is negative, is not a number or does not increase is refused', async () => {
    const { text } = base()
    const at = JSON.parse(text).campaigns[0].branches.b1.races[1].snapshots[0].t

    refused(sealed(text.replace(`"t":${at},`, '"t":1e999,')), /no finite, non-negative game time/)
    refused(sealed(text.replace(`"t":${at},`, '"t":-5,')), /no finite, non-negative game time/)
    refused(sealed(text.replace(`"t":${at},`, '"t":"100",')), /no finite, non-negative game time/)
    refused(edited((doc) => { doc.campaigns[0].branches.b1.races[1].snapshots.reverse() }), /not later than the one before it/)
    refused(edited((doc) => { const list = doc.campaigns[0].branches.b1.races[1].snapshots; list[1].t = list[0].t }), /not later than the one before it/)
  })

  check('rejection', 'an id that could name a file or a prototype key, or a race id that is not canonical, is refused', async () => {
    refused(edited((doc) => { doc.campaigns[0].id = '../evil'; doc.campaigns[0].entry.id = '../evil' }), /no campaign id/)
    refused(edited((doc) => { doc.campaigns[0].branches.b1.races['01'] = doc.campaigns[0].branches.b1.races[1] }), /not a race id/)
    refused(edited((doc) => { doc.campaigns[0].branches.b1.races['1.5'] = doc.campaigns[0].branches.b1.races[1] }), /not a race id/)
    refused(edited((doc) => { doc.campaigns[0].branches['b1/../b9'] = doc.campaigns[0].branches.b1 }), /history file for each of its branches/)

    const { text } = base()

    refused(sealed(text.replace('"races":{"1":', '"races":{"__proto__":')), /not a race id/)
    refused(sealed(text.replace('"intel":{"1":{"2":', '"intel":{"1":{"__proto__":')), /not a race id/)
    refused(sealed(text.split('"b1"').join('"x1"')), /branches are not valid/)
    assert.equal({}.polluted, undefined)
  })

  check('rejection', 'a figure with units the backup does not state or states differently, and a figure of the wrong shape, is refused', async () => {
    refused(edited((doc) => { doc.units.race.population = 'people' }), /measured in people here and in million people/)
    refused(edited((doc) => { doc.units.intelligence.tons = 'kilotons' }), /measured in kilotons/)
    refused(edited((doc) => { doc.units.race.secret = 'beans' }), /secret is not one this version records/)
    refused(edited((doc) => { delete doc.units.race }), /units are not stated/)
    refused(edited((doc) => { doc.campaigns[0].branches.b1.races[1].snapshots[0].secret = 1 }), /holds the figure secret/)
    refused(edited((doc) => { doc.campaigns[0].branches.b1.races[1].snapshots[0].population = '12' }), /population is not a finite number or null/)
    refused(edited((doc) => { doc.campaigns[0].branches.b1.races[1].snapshots[0].minerals = [1, 2] }), /minerals is not 11 amounts/)
    refused(edited((doc) => { doc.campaigns[0].branches.b1.races[1].snapshots[0].installations = { x: 1 } }), /installations is not amounts/)
    refused(edited((doc) => { doc.campaigns[0].branches.b1.intel[1][2].snapshots[0].unknownFigure = 1 }), /holds the figure unknownFigure/)
  })

  check('rejection', 'a snapshot may carry the chain of the ledger it was taken on, which is kept through a restore, and a malformed one or one on an intelligence snapshot is refused', async () => {
    const digest = '0123456789abcdef'
    const snapshotsOf = (doc) => doc.campaigns[0].branches.b1.races[1].snapshots
    const read = (change) => backup.parseBackup(edited(change))
    const kept = read((doc) => { snapshotsOf(doc)[0].chain = { n: 12, digest } })

    assert.ok(kept.envelope, JSON.stringify(kept.errors))
    assert.deepEqual(kept.envelope.campaigns[0].branches.b1.races[1].snapshots[0].chain, { n: 12, digest })
    assert.ok(read(() => {}).envelope, 'a snapshot with no chain is read as before')

    const target = installation({ first: 2 })

    await restore(target, kept.envelope)

    assert.deepEqual(target.fileOf('c1', 'b1').races[1].snapshots[0].chain, { n: 12, digest })

    ;[{ n: 0, digest }, { n: 1.5, digest }, { n: -3, digest }, { n: 12, digest: 'xyz' }, { n: 12, digest: digest.toUpperCase() }, { n: 12 }, { digest }, { n: 12, digest, extra: 1 }, 'text', 7, [12, digest], null].forEach((chain) => {
      refused(edited((doc) => { snapshotsOf(doc)[0].chain = chain }), /chain is not the increment count and 16-digit digest/)
    })

    refused(edited((doc) => { doc.campaigns[0].branches.b1.intel[1][2].snapshots[0].chain = { n: 12, digest } }), /holds the figure chain/)
  })

  check('rejection', 'a series whose coverage does not match its snapshots, or that is longer than the retention cap, is refused', async () => {
    refused(edited((doc) => { doc.campaigns[0].branches.b1.races[1].coverage.count = 99 }), /coverage does not match/)
    refused(edited((doc) => { doc.campaigns[0].branches.b1.races[1].coverage.last = 1 }), /coverage does not match/)
    refused(edited((doc) => { delete doc.campaigns[0].branches.b1.races[1].coverage }), /coverage does not match/)
    refused(edited((doc) => {
      const series = doc.campaigns[0].branches.b1.races[1]

      series.snapshots = Array.from({ length: 2001 }, (_, index) => snapshot(index + 1))
      series.coverage = { count: 2001, first: 1, last: 2001 }
    }), /list of at most 2000/)
  })

  check('rejection', 'a backup that was altered, truncated or damaged after it was made is refused by its digest', async () => {
    const { text } = base()
    const doc = JSON.parse(text)

    doc.campaigns[0].branches.b1.races[1].snapshots[0].population = 1

    refused(JSON.stringify(doc), /altered or damaged/)

    const fewer = JSON.parse(text)

    fewer.campaigns[0].annotations.pop()
    refused(JSON.stringify(fewer), /altered or damaged/)
  })

  check('rejection', 'a file larger than the limit is refused before it is parsed, and a record that is not valid for the registry is refused', async () => {
    const original = JSON.parse
    let parses = 0

    JSON.parse = (...args) => {
      parses++

      return original(...args)
    }

    try {
      refused('x'.repeat(backup.MAX_BYTES + 1), /larger than 50 MB/)
      assert.equal(parses, 0)
    } finally {
      JSON.parse = original
    }

    refused(edited((doc) => { delete doc.campaigns[0].entry.branches.b1.tip }), /not a ledger tip/)
    refused(edited((doc) => { doc.campaigns[0].entry.attachments = Array.from({ length: 51 }, (_, index) => ({ path: `p${index}`, GameID: 1, branchId: 'b1', lastSeen: 1, answer: null, pending: [] })) }), /at most 50/)
    refused(edited((doc) => { doc.campaigns[0].entry.attachments = [{ path: 'p', GameID: 1, branchId: 'b9', lastSeen: 1, answer: null, pending: [] }] }), /attached save is not valid/)
    refused(edited((doc) => { doc.campaigns[0].entry.anchor = 'x' }), /anchor is not valid/)
    refused(edited((doc) => { doc.campaigns[0].annotations[0].source.campaignId = 'other' }), /does not name the campaign/)
    refused(edited((doc) => { doc.campaigns[0].annotations[0].records[0] = { kind: 'x' } }), /has no uuid/)
  })

  check('rejection', 'a refused file leaves every file of the installation byte-identical, and nothing is previewed from it', async () => {
    await withDir(async (dir) => {
      const { stored } = pair()
      const live = installation({ dir })

      seed(live, { entries: [stored.registry().campaigns.c1], files: { 'c1-b1': stored.fileOf('c1', 'b1') } })

      const bytes = live.bytes()
      const memory = live.snapshot()
      const attempts = [edited((doc) => { doc.version = 4 }), edited((doc) => { doc.campaigns[0].branches.b1.races[1].snapshots.reverse() }), '{', 'x'.repeat(backup.MAX_BYTES + 1)]

      attempts.forEach((body) => {
        const out = backup.parseBackup(body)

        assert.equal(out.envelope, undefined)
        assert.ok(out.errors.length)
      })

      assert.equal(live.writes.length, 0)
      assert.equal(live.bytes(), bytes)
      assert.equal(live.snapshot(), memory)
      assert.deepEqual(live.fileOf('c1', 'b1'), stored.fileOf('c1', 'b1'))
    })
  })

  // ---- association ----

  check('association', 'a campaign of the same id with a different galaxy is refused, and nothing of it is restored', async () => {
    const stored = installation()
    const other = installation({ first: 2 })

    seed(stored, { entries: [entryOf({ id: 'c1', key: 1 })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }) } })
    seed(other, { entries: [entryOf({ id: 'c1', key: 2 })], files: { 'c1-b1': fileOf({ races: { 1: { times: [200, 300] } } }) } })

    const before = stored.snapshot()
    const planned = plan(stored, parsed(exportOf(other)), { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } })
    const [view] = planned.preview.campaigns

    assert.equal(view.status, 'conflict')
    assert.equal(view.skipped, true)
    assert.equal(view.files[0].policy, 'keep')
    assert.match(view.files[0].locked, /different galaxy/)
    assert.equal(planned.preview.nothingToDo, true)

    const { result } = await restore(stored, parsed(exportOf(other)))

    assert.equal(result.applied, false)
    assert.equal(stored.snapshot(), before)
  })

  check('association', 'a stored answer, merge mark, legacy mark and pending question are never overwritten, and what differs is reported', async () => {
    const answered = { path: 'C:/saves/a.db', GameID: 1, gameName: 'Campaign', branchId: 'b1', lastSeen: 50, answer: 'separate', pending: [] }
    const unanswered = { path: 'C:/saves/q.db', GameID: 1, gameName: 'Campaign', branchId: 'b1', lastSeen: 40, answer: null, pending: [{ campaignId: 'x1', branchId: 'b1' }] }
    const stored = installation()
    const other = installation({ first: 2 })
    const storedEntry = entryOf({ id: 'c1', attachments: [answered, unanswered], extra: { legacy: { unit: 'kept' } } })
    const given = entryOf({ id: 'c1', name: 'Renamed campaign', seen: 500, createdAt: 50, attachments: [{ ...answered, answer: 'attached-by-player', lastSeen: 90 }, { ...unanswered, answer: 'inferred', pending: [] }, { path: 'C:/saves/new.db', GameID: 1, gameName: 'Campaign', branchId: 'b1', lastSeen: 10, answer: 'inferred', pending: [] }], extra: { mergedInto: { campaignId: 'z9', branchId: 'b1', at: 5 }, legacy: { unit: 'other' } } })

    given.names[0].seen = 300
    given.names[0].t = 9
    seed(stored, { entries: [storedEntry], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }) } })
    seed(other, { entries: [given], files: { 'c1-b1': fileOf({ races: { 1: { times: [100, 200] } } }) } })

    const planned = plan(stored, parsed(exportOf(other)))

    assert.ok(planned.preview.campaigns[0].association.kept.length >= 3, planned.preview.campaigns[0].association.kept.join('|'))

    await restore(stored, parsed(exportOf(other)))

    const after = stored.registry().campaigns.c1

    assert.deepEqual(after.attachments.find((item) => item.path === answered.path), answered)
    assert.deepEqual(after.attachments.find((item) => item.path === unanswered.path), unanswered)
    assert.equal(after.attachments.length, 3)
    assert.equal(after.mergedInto, undefined)
    assert.deepEqual(after.legacy, { unit: 'kept' })
    assert.deepEqual(after.names.map((item) => item.name), ['Campaign', 'Renamed campaign'])
    assert.equal(after.seen, 500)
    assert.equal(after.createdAt, 50)
    assert.deepEqual(after.provenance, storedEntry.provenance)
  })

  check('association', 'a campaign of another id that shares a game id is restored as a campaign of its own, merged into nothing, and only on confirmation', async () => {
    const stored = installation()
    const other = installation({ first: 2 })

    seed(stored, { entries: [entryOf({ id: 'c1' })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100, 200] } } }) } })
    seed(other, { entries: [entryOf({ id: 'c9' })], files: { 'c9-b1': fileOf({ races: { 1: { times: [300] } } }) } })

    const envelope = parsed(exportOf(other))
    const planned = plan(stored, envelope)
    const before = stored.snapshot()

    assert.equal(planned.preview.campaigns[0].status, 'ambiguous')
    assert.match(planned.preview.campaigns[0].notes[0], /nothing is merged/)
    assert.equal(planned.preview.needsConfirmation.length, 1)

    await rejects(() => backup.applyRestore({ io: stored.io, envelope, expected: planned.digest, confirmed: false, now: stored.now }), 'Rejected')
    assert.equal(stored.snapshot(), before)

    await restore(stored, envelope)

    assert.deepEqual(Object.keys(stored.registry().campaigns).sort(), ['c1', 'c9'])
    assert.deepEqual(stored.registry().campaigns.c1, entryOf({ id: 'c1' }))
    assert.equal(stored.registry().campaigns.c9.mergedInto, undefined)
    assert.deepEqual(timesOf(stored.fileOf('c1')), [100, 200])
    assert.deepEqual(timesOf(stored.fileOf('c9')), [300])
  })

  check('association', 'a branch whose timeline is not the stored one, or cannot be told from it, is never merged into it and keeps its stored file', async () => {
    const stored = installation()
    const other = installation({ first: 2 })
    const unknownA = { n: 10, digest: 'a', checkpoints: [] }
    const unknownB = { n: 20, digest: 'b', checkpoints: [] }

    seed(stored, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(150), b2: unknownA } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }), 'c1-b2': fileOf({ races: { 1: { times: [100] } } }) } })
    seed(other, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(150, 7), b2: unknownB } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [200] } } }), 'c1-b2': fileOf({ races: { 1: { times: [200] } } }) } })

    const before = stored.snapshot()
    const planned = plan(stored, parsed(exportOf(other)), { campaigns: { c1: { files: { b1: { policy: 'replace' }, b2: { policy: 'replace' } } } } })
    const [b1, b2] = planned.preview.campaigns[0].files

    assert.equal(b1.relation, 'different')
    assert.match(b1.locked, /different timeline/)
    assert.equal(b2.relation, 'unknown')
    assert.match(b2.locked, /too little is recorded/)
    assert.ok(b1.policy === 'keep' && b2.policy === 'keep')

    const association = planned.preview.campaigns[0].association

    assert.equal(association.added.tips, 0)
    assert.ok(association.kept.some((note) => /branch b1 is a different timeline in the backup/.test(note)), association.kept.join('|'))
    assert.ok(association.kept.some((note) => /branch b2 cannot be told from the stored one/.test(note)), association.kept.join('|'))

    await restore(stored, parsed(exportOf(other)))

    assert.equal(stored.snapshot(), before)
  })

  check('association', 'a tip further along the same timeline advances the stored tip, and one behind it never moves it back', async () => {
    const stored = installation()
    const other = installation({ first: 2 })

    seed(stored, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(64) } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }) } })
    seed(other, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(128) } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100, 200] } } }) } })

    assert.equal(plan(stored, parsed(exportOf(other))).preview.campaigns[0].files[0].relation, 'extends')

    await restore(stored, parsed(exportOf(other)))

    assert.deepEqual(stored.registry().campaigns.c1.branches.b1.tip, tipOf(128))

    const behind = installation({ first: 3 })

    seed(behind, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(64) } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }) } })

    const older = plan(stored, parsed(exportOf(behind)))

    assert.equal(older.preview.campaigns[0].files[0].relation, 'behind')

    const before = stored.snapshot()
    const { result } = await restore(stored, parsed(exportOf(behind)))

    assert.equal(result.applied, false)
    assert.equal(stored.snapshot(), before)
    assert.deepEqual(stored.registry().campaigns.c1.branches.b1.tip, tipOf(128))
  })

  check('association', 'the campaign record is chosen separately: kept, it leaves the registry as it is and skips a campaign the installation does not hold', async () => {
    const stored = installation()
    const other = installation({ first: 2 })

    seed(stored, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(64) } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }) } })
    seed(other, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(128), b2: tipOf(100) } }), entryOf({ id: 'c7', GameID: 7, key: 7 })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100, 200] } } }), 'c1-b2': fileOf({ races: { 1: { times: [100] } } }), 'c7-b1': fileOf({ races: { 1: { times: [5] } } }) } })

    const choices = { campaigns: { c1: { association: 'keep' }, c7: { association: 'keep' } } }
    const registryBefore = stored.registry()

    await restore(stored, parsed(exportOf(other)), choices)

    assert.deepEqual(stored.registry(), registryBefore)
    assert.deepEqual(timesOf(stored.fileOf('c1')), [100, 200], 'the history of a branch the registry holds is still merged')
    assert.equal(stored.files.has('file:campaign-c1-b2'), false, 'a branch the registry does not hold is not restored')
    assert.equal(stored.files.has('file:campaign-c7-b1'), false)
  })

  check('association', 'the unattached legacy history, the migration record and the settings are never touched by a restore', async () => {
    const { stored, other } = pair()
    const pool = { legacy1: { id: 'legacy1', GameID: 1, attachedTo: null } }

    stored.put('registry', { ...stored.registry(), pool })
    stored.put('migration', { version: 1, units: { 1: { state: 'committed' } } })
    stored.put('settings', { campaign: { c1: { race: { 1: { mapPinned: [1] } } } } })
    stored.put('file:game-1', { gameName: 'Legacy', races: {}, intel: {} })

    const untouched = ['migration', 'settings', 'file:game-1'].map((name) => JSON.stringify(stored.files.get(name)))

    await restore(stored, parsed(exportOf(other)))

    assert.deepEqual(['migration', 'settings', 'file:game-1'].map((name) => JSON.stringify(stored.files.get(name))), untouched)
    assert.deepEqual(stored.registry().pool, pool)
  })

  // ---- policy ----

  check('policy', 'a merge keeps the stored snapshot at a shared time, adds the rest in time order and thins what passes the cap', async () => {
    const stored = installation()
    const other = installation({ first: 2 })
    const even = Array.from({ length: 1500 }, (_, index) => (index + 1) * 2)
    const odd = [...Array.from({ length: 1500 }, (_, index) => (index + 1) * 2 - 1), 2998, 3000]

    seed(stored, { entries: [entryOf({ id: 'c1' })], files: { 'c1-b1': fileOf({ races: { 1: { times: even, over: { 3000: { population: 7 } } } } }) } })
    seed(other, { entries: [entryOf({ id: 'c1' })], files: { 'c1-b1': fileOf({ races: { 1: { times: odd.sort((a, b) => a - b), over: { 3000: { population: 8 } } } } }) } })

    const planned = plan(stored, parsed(exportOf(other)))
    const row = planned.preview.campaigns[0].files[0].series[0]

    assert.ok(row.thinned > 0 && row.result <= 2000 && row.added === 1500 && row.identical + row.conflicts === 2, JSON.stringify(row))

    await restore(stored, parsed(exportOf(other)))

    const times = timesOf(stored.fileOf('c1'))

    assert.equal(times.length, row.result)
    assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]))
    assert.equal(stored.fileOf('c1').races[1].snapshots.find((item) => item.t === 3000).population, 7)
    assert.equal(times[times.length - 1], 3000, 'the newest half is not thinned')
  })

  check('policy', 'replace makes the selected series the backup\'s and counts what it removes, and a series of a race that is not selected is left alone', async () => {
    const stored = installation()
    const other = installation({ first: 2 })

    seed(stored, { entries: [entryOf({ id: 'c1' })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100, 200, 300] }, 2: { times: [100, 200] } }, intel: { 1: { 2: { times: [100] } }, 2: { 1: { times: [100] } } } }) } })
    seed(other, { entries: [entryOf({ id: 'c1' })], files: { 'c1-b1': fileOf({ races: { 1: { times: [250] }, 2: { times: [150] } }, intel: { 1: { 2: { times: [250] } }, 2: { 1: { times: [250] } } } }) } })

    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace', races: ['1'] } } } } }
    const planned = plan(stored, parsed(exportOf(other)), choices)
    const rows = planned.preview.campaigns[0].files[0].series

    assert.deepEqual(rows.map((row) => row.key).sort(), ['intel:1:2', 'race:1'])
    assert.equal(rows.find((row) => row.key === 'race:1').removed, 3)

    await restore(stored, parsed(exportOf(other)), choices)

    const file = stored.fileOf('c1')

    assert.deepEqual(timesOf(file, 1), [250])
    assert.deepEqual(timesOf(file, 2), [100, 200])
    assert.deepEqual(file.intel[1][2].snapshots.map((item) => item.t), [250])
    assert.deepEqual(file.intel[2][1].snapshots.map((item) => item.t), [100])
  })

  check('policy', 'each target takes its own policy: one branch merged, one replaced, one kept, and a kept file is not written', async () => {
    const stored = installation()
    const other = installation({ first: 2 })
    const tips = { b1: tipOf(100), b2: tipOf(100), b3: tipOf(100), b4: tipOf(100) }

    seed(stored, { entries: [entryOf({ id: 'c1', branches: tips })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }), 'c1-b2': fileOf({ races: { 1: { times: [100] } } }), 'c1-b3': fileOf({ races: { 1: { times: [100] } }, intel: { 1: { 2: { times: [100] } } } }) } })
    seed(other, { entries: [entryOf({ id: 'c1', branches: tips })], files: { 'c1-b1': fileOf({ races: { 1: { times: [200] } } }), 'c1-b2': fileOf({ races: { 1: { times: [200] } } }), 'c1-b3': fileOf({ races: { 1: { times: [200] } }, intel: { 1: { 2: { times: [200] } } } }), 'c1-b4': fileOf({ races: { 1: { times: [200] } } }) } })

    const before = stored.fileOf('c1', 'b3')

    await restore(stored, parsed(exportOf(other)), { campaigns: { c1: { files: { b1: { policy: 'merge' }, b2: { policy: 'replace' }, b3: { policy: 'keep' }, b4: { policy: 'keep' } } } } })

    assert.deepEqual(timesOf(stored.fileOf('c1', 'b1')), [100, 200])
    assert.deepEqual(timesOf(stored.fileOf('c1', 'b2')), [200])
    assert.deepEqual(stored.fileOf('c1', 'b3'), before)
    assert.equal(stored.writes.includes('file:campaign-c1-b3'), false)
    assert.equal(stored.writes.includes('file:campaign-c1-b4'), false)
  })

  check('policy', 'newer metadata is kept: the name of the side whose series reaches the later game time, the stored one on a tie, and the registry never moves back', async () => {
    const run = async (storedLast, givenLast, name) => {
      const stored = installation()
      const other = installation({ first: 2 })

      seed(stored, { entries: [entryOf({ id: 'c1', createdAt: 100, seen: 500 })], files: { 'c1-b1': fileOf({ races: { 1: { raceName: 'Stored name', times: [100, storedLast] } }, intel: { 1: { 2: { name: 'Stored alien', times: [100, storedLast] } } } }) } })
      seed(other, { entries: [entryOf({ id: 'c1', createdAt: 50, seen: 300 })], files: { 'c1-b1': fileOf({ races: { 1: { raceName: 'Backup name', times: [150, givenLast] } }, intel: { 1: { 2: { name: 'Backup alien', times: [150, givenLast] } } } }) } })

      await restore(stored, parsed(exportOf(other)))

      const file = stored.fileOf('c1')

      assert.equal(file.races[1].raceName, name)
      assert.equal(file.intel[1][2].name, name === 'Stored name' ? 'Stored alien' : 'Backup alien')
      assert.equal(stored.registry().campaigns.c1.seen, 500)
      assert.equal(stored.registry().campaigns.c1.createdAt, 50)
    }

    await run(500, 300, 'Stored name')
    await run(300, 700, 'Backup name')
    await run(400, 400, 'Stored name')
  })

  // ---- apply ----

  check('apply', 'a backup of the affected campaigns, as they were, is written before any file and is a backup this version reads', async () => {
    const { stored, other } = pair()
    const was = exportOf(stored, { at: 1 })
    const { result } = await restore(stored, parsed(exportOf(other)))
    const order = stored.writes.filter((name, index) => stored.writes.indexOf(name) === index)

    assert.equal(order[0], 'backup')
    assert.equal(result.backup.label, 'before restoring Campaign')

    const [kept] = backup.keptBackups(stored.io)

    assert.equal(parsed(kept.envelope).campaigns.length, 1)
    assert.deepEqual(kept.envelope.campaigns, was.campaigns)
    assert.equal(kept.envelope.digest, was.digest)
  })

  check('apply', 'a pre-restore backup restores the files as they were, by replace', async () => {
    const { stored, other } = pair()
    const before = { b1: stored.fileOf('c1', 'b1'), b2: stored.fileOf('c1', 'b2') }

    await restore(stored, parsed(exportOf(other)))

    assert.notDeepEqual(stored.fileOf('c1', 'b1'), before.b1)

    const [kept] = backup.keptBackups(stored.io)
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' }, b2: { policy: 'replace' } } } } }

    await restore(stored, parsed(kept.envelope), choices)

    assert.deepEqual(stored.fileOf('c1', 'b1').races[1], before.b1.races[1])
    assert.deepEqual(stored.fileOf('c1', 'b2'), before.b2)
  })

  check('apply', 'only the newest few backups are kept, newest first', async () => {
    const { stored, other } = pair()

    for (let round = 0; round < backup.KEPT_BACKUPS + 2; round++) {
      const extra = installation({ first: 5 + round })

      seed(extra, { entries: [stored.registry().campaigns.c1], files: { 'c1-b1': fileOf({ races: { 1: { times: [1000 + round] } } }) } })
      await restore(stored, parsed(exportOf(extra, { at: 100 + round })))
    }

    const kept = backup.keptBackups(stored.io)

    assert.equal(kept.length, backup.KEPT_BACKUPS)
    assert.ok(kept.every((entry, index) => index === 0 || entry.at < kept[index - 1].at))
    assert.ok(other)
  })

  check('apply', 'a backup that cannot be kept stops the restore with nothing written', async () => {
    const { stored, other } = pair()
    const envelope = parsed(exportOf(other))
    const planned = plan(stored, envelope)
    const before = stored.snapshot()

    stored.hooks.beforeWrite = (name) => {
      if (name === 'backup') {
        throw new Error('the disk is full')
      }
    }

    const error = await rejects(() => backup.applyRestore({ io: stored.io, envelope, expected: planned.digest, now: stored.now }), 'Rejected')

    assert.match(error.message, /could not be kept \(the disk is full\), so nothing was restored/)
    assert.equal(stored.snapshot(), before)

    stored.hooks.beforeWrite = null
    stored.io.backup.update = undefined

    const silent = { ...stored.io, backup: { get store () { return {} }, set store (_value) {} } }

    await rejects(() => backup.applyRestore({ io: silent, envelope, expected: planned.digest, now: stored.now }), 'Rejected')
    assert.equal(stored.snapshot(), before)
    await rejects(() => backup.applyRestore({ io: { ...stored.io, backup: undefined }, envelope, expected: planned.digest, now: stored.now }), 'Rejected')
    assert.equal(stored.snapshot(), before)
  })

  check('apply', 'a plan that is no longer what the preview showed is refused as changed, and nothing is written', async () => {
    const { stored, other } = pair()
    const envelope = parsed(exportOf(other))
    const attachment = { path: 'C:/n.db', GameID: 1, gameName: 'Campaign', branchId: 'b1', lastSeen: 5, answer: 'inferred', pending: [] }

    envelope.campaigns[0].entry.attachments = [...(envelope.campaigns[0].entry.attachments || []), attachment]
    envelope.digest = campaign.hashValue(envelope.campaigns)

    const planned = plan(stored, envelope)

    assert.ok(planned.preview.totals.registry >= 1, 'the preview shows a change of the record')

    const registry = stored.registry()

    stored.put('registry', { ...registry, campaigns: { c1: { ...registry.campaigns.c1, attachments: [...(registry.campaigns.c1.attachments || []), attachment] } } })

    const before = stored.snapshot()
    const error = await rejects(() => backup.applyRestore({ io: stored.io, envelope, expected: planned.digest, now: stored.now }), 'Changed')

    assert.equal(error.changed, true)
    assert.equal(stored.snapshot(), before)

    stored.put('file:campaign-c1-b1', fileOf({ races: { 1: { times: [100, 120] } } }))

    const again = plan(stored, envelope)

    stored.put('file:campaign-c1-b1', fileOf({ races: { 1: { times: [100, 130] } } }))
    await rejects(() => backup.applyRestore({ io: stored.io, envelope, expected: again.digest, now: stored.now }), 'Changed')
    await rejects(() => backup.applyRestore({ io: stored.io, envelope, expected: 'stale', now: stored.now }), 'Changed')
  })

  check('apply', 'a tab that does not record cannot apply, whatever it is asked, and writes nothing', async () => {
    const { stored, other } = pair()
    const envelope = parsed(exportOf(other))
    const planned = plan(stored, envelope)
    const before = stored.snapshot()
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

    Object.defineProperty(globalThis, 'navigator', { value: { locks: { request: () => new Promise(() => {}) } }, configurable: true })

    try {
      m.owner.claimRecording({ database: 'tab-check' })
      assert.equal(m.owner.ownsRecording(), false)

      const error = await rejects(() => backup.applyRestore({ io: stored.io, envelope, expected: planned.digest, confirmed: true, now: stored.now }), 'ReadOnly')

      assert.equal(error.readOnly, true)
      assert.equal(stored.snapshot(), before)
    } finally {
      m.owner.releaseRecording()

      if (descriptor) {
        Object.defineProperty(globalThis, 'navigator', descriptor)
      } else {
        delete globalThis.navigator
      }
    }

    assert.equal(m.owner.ownsRecording(), true)
  })

  check('apply', 'a restore that stopped part way is run again and finishes, and one that finished writes nothing the second time', async () => {
    const { stored, other } = pair()
    const envelope = parsed(exportOf(other))
    const planned = plan(stored, envelope)

    stored.hooks.beforeWrite = (_name, index) => {
      if (index === 2) {
        throw new Error('the disk is full')
      }
    }

    await assert.rejects(() => backup.applyRestore({ io: stored.io, envelope, expected: planned.digest, now: stored.now }), /disk is full/)
    assert.ok(stored.writes.length >= 2)

    stored.hooks.beforeWrite = null

    const second = plan(stored, envelope)
    const finished = await backup.applyRestore({ io: stored.io, envelope, expected: second.digest, now: stored.now })

    assert.equal(finished.applied, true)
    assert.deepEqual(timesOf(stored.fileOf('c1')), [100, 200, 300, 400, 500])

    const count = stored.writes.length
    const third = plan(stored, envelope)
    const again = await backup.applyRestore({ io: stored.io, envelope, expected: third.digest, now: stored.now })

    assert.equal(third.preview.nothingToDo, true)
    assert.equal(again.applied, false)
    assert.equal(stored.writes.length, count)
  })

  check('apply', 'the registry is written last, by its compare-and-swap, so a registry another writer changed is not overwritten', async () => {
    const { stored, other } = pair()
    const envelope = parsed(exportOf(other, { at: 1 }))

    envelope.campaigns[0].entry.names.push({ name: 'Later name', t: 50, seen: 900 })
    envelope.digest = campaign.hashValue(envelope.campaigns)

    const planned = plan(stored, envelope)

    assert.equal(planned.preview.totals.registry, 1)

    await restore(stored, envelope)

    assert.deepEqual(stored.writes.slice(-2), ['registry', 'backup'], 'the registry is the last of the restore writes; only the filing of the kept backup follows')
    assert.equal(stored.registry().campaigns.c1.names.length, 2)

    const racing = installation()

    seed(racing, { entries: [entryOf({ id: 'c1' })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }) } })

    const next = plan(racing, envelope)
    const registry = racing.registry()

    racing.io.registry.store = { ...registry, campaigns: { c1: { ...registry.campaigns.c1, seen: 999 } } }

    const error = await rejects(() => backup.applyRestore({ io: racing.io, envelope, expected: next.digest, now: racing.now }), 'Changed')

    assert.ok(error)

    const raced = pair()
    const racedEnvelope = parsed(exportOf(raced.other, { at: 1 }))

    racedEnvelope.campaigns[0].entry.names.push({ name: 'Later name', t: 50, seen: 900 })
    racedEnvelope.digest = campaign.hashValue(racedEnvelope.campaigns)

    const racedPlan = plan(raced.stored, racedEnvelope)
    let moved = false
    const guard = () => {
      if (!moved && raced.stored.writes.includes('file:campaign-c1-b2')) {
        moved = true

        const current = raced.stored.registry()

        raced.stored.put('registry', { ...current, campaigns: { c1: { ...current.campaigns.c1, seen: 999 } } })
      }
    }

    await rejects(() => backup.applyRestore({ io: raced.stored.io, envelope: racedEnvelope, expected: racedPlan.digest, now: raced.stored.now, guard }), 'RegistryChanged')
    assert.equal(moved, true)
    assert.equal(raced.stored.registry().campaigns.c1.seen, 999, 'what the other writer wrote is still there')
    assert.equal(raced.stored.registry().campaigns.c1.names.length, 1, 'and nothing of the backup was written over it')
  })

  // ---- annotations ----

  check('annotations', 'a record is restored once with its uuid, never over a stored one and never when it was deleted here', async () => {
    const world = annotated()
    const b = installation({ first: 2 })

    await restore(b, parsed(exportOf(world.a, { annotations: world.annotationsA })), {}, { annotations: world.annotationsB(b) })

    const repoB = world.repositoryB(b)
    const scope = world.scope(1, 'b1')
    const [first, second, third] = world.notes.filter((note) => note.RaceID === 1 && note.branch === 'b1')
    const stored = JSON.stringify(repoB.read(scope, first.uuid).record)

    repoB.delete(scope, second.uuid, 1)

    const added = world.repositoryA.create(world.scope(1, 'b1', 5000), { kind: 'colony-note', payload: { text: 'later' }, links: [{ type: 'colony', id: 5, row: { name: 'Earth', size: 1 } }] })
    const envelope = parsed(exportOf(world.a, { annotations: world.annotationsA }))
    const planned = plan(b, envelope, {}, world.annotationsB(b))
    const group = planned.preview.campaigns[0].annotations.groups.find((row) => row.RaceID === 1 && row.branchId === 'b1')

    assert.deepEqual({ records: group.records, add: group.add, existing: group.existing, deleted: group.deleted, rejected: group.rejected }, { records: 4, add: 1, existing: 2, deleted: 1, rejected: 0 })

    const before = b.snapshot()

    plan(b, envelope, {}, world.annotationsB(b))
    assert.equal(b.snapshot(), before, 'a preview writes nothing')

    const { result } = await restore(b, envelope, {}, { annotations: world.annotationsB(b) })
    const uuids = repoB.list(scope).map((entry) => entry.record.uuid)

    assert.equal(result.imports, 1)
    assert.deepEqual(uuids.sort(), [first.uuid, third.uuid, added.uuid].sort())
    assert.equal(JSON.stringify(repoB.read(scope, first.uuid).record), stored, 'a stored record is untouched')
    assert.equal(repoB.read(scope, second.uuid), null, 'a deleted record stays deleted')
    assert.equal(repoB.read(scope, added.uuid).record.revision, 1)

    const again = plan(b, envelope, {}, world.annotationsB(b))

    assert.equal(again.preview.campaigns[0].annotations.groups.find((row) => row.RaceID === 1 && row.branchId === 'b1').add, 0)
  })

  check('annotations', 'annotations are chosen separately: kept, none is restored, and a kind this installation has no adapter for is reported and not restored', async () => {
    const world = annotated()
    const envelope = parsed(exportOf(world.a, { annotations: world.annotationsA }))
    const kept = installation({ first: 2 })
    const result = await restore(kept, envelope, { campaigns: { c1: { annotations: 'keep' } } }, { annotations: world.annotationsB(kept) })

    assert.equal(result.result.imports, 0)
    assert.ok(result.planned.preview.campaigns[0].annotations.groups.every((group) => group.add === 0))
    assert.equal(kept.files.has('scenario-c1'), false)
    assert.deepEqual(kept.fileOf('c1', 'b1'), world.a.fileOf('c1', 'b1'), 'the history is restored all the same')

    const bare = installation({ first: 3 })
    const none = backup.annotationsOf(records.createRepository({ storage: world.storageOf(bare), adapters: records.createAdapterRegistry(), now: bare.now }), world.storageOf(bare))
    const unsupported = plan(bare, envelope, {}, none)
    const groups = unsupported.preview.campaigns[0].annotations.groups

    assert.ok(groups.every((group) => group.add === 0 && group.rejected === group.records && /no adapter/.test(group.reasons[0])), JSON.stringify(groups))
    assert.equal(unsupported.preview.totals.annotations, 0)

    const without = plan(bare, envelope, {}, null)

    assert.equal(without.preview.campaigns[0].annotations.available, false)
  })

  const storageOf = (inst) => ({ open: (campaignId) => inst.store(`scenario-${campaignId}`), registry: () => clone(inst.files.get('registry')) || {} })

  // A planner's adapter for a note with one typed link, as the scenario records' own checks use.
  const noteAdapters = () => {
    const registry = records.createAdapterRegistry()

    registry.register({
      kind: 'colony-note',
      schema: 1,
      validate: (payload) => (typeof payload.text === 'string' ? true : 'a colony note has text'),
      fingerprint: (type, row) => [type, row.name, row.size].join(':'),
      resolve: (links, context) => links.map((link) => (context.rows && context.rows[link.type] && context.rows[link.type][link.id]) || null),
      versions: { 'notes.rules': '1' },
    })

    return registry
  }

  // An installation `a` holding campaign c1 (branches b1 and b2, intelligence, and five notes of two races on two branches), and what restoring into another needs: each installation's scenario storage, repository and the backup's adapter over it.
  const annotated = () => {
    const a = installation()
    const adapters = noteAdapters()
    const make = (inst, first) => {
      let n = first

      return records.createRepository({ storage: storageOf(inst), adapters, newId: () => uuid(++n), now: inst.now })
    }
    const repositoryA = make(a, 0)
    const scope = (RaceID, branchId, gameTime = 1000) => ({ campaignId: 'c1', RaceID, branchId, gameTime })
    const note = (RaceID, branchId, text, policy = 'campaign') => repositoryA.create(scope(RaceID, branchId), { kind: 'colony-note', payload: { text }, policy, links: [{ type: 'colony', id: 5, row: { name: 'Earth', size: 1 } }] })

    seed(a, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(100), b2: tipOf(100) } })], files: { 'c1-b1': fileOf({ races: { 1: { raceName: 'Terran', times: [100, 200, 300] }, 2: { raceName: 'Alien', npr: true, times: [100, 200] } }, intel: { 1: { 2: { name: 'Alien', times: [100, 300] } } } }), 'c1-b2': fileOf({ races: { 1: { times: [100, 250] } } }) } })

    const notes = [note(1, 'b1', 'first'), note(1, 'b1', 'second', 'branch'), note(1, 'b1', 'third'), note(1, 'b2', 'other branch', 'branch'), note(2, 'b1', 'other race')].map((made) => ({ uuid: made.uuid, RaceID: made.RaceID, branch: made.association.branchId }))

    return { a, notes, repositoryA, scope, storageOf, repositoryB: (inst) => make(inst, 1000), annotationsA: backup.annotationsOf(repositoryA, storageOf(a)), annotationsB: (inst) => backup.annotationsOf(make(inst, 2000), storageOf(inst)) }
  }

  // ---- the review of the first delivery ----

  // A tip of `n` increments whose ledger differs from the plain one after the increment `forkAt`.
  const forked = (n, forkAt) => {
    const scan = campaign.scanLedger(Array.from({ length: n }, (_, index) => ({ IncrementID: index + 1, GameTime: (index + 1) * 5 + (index + 1 > forkAt ? 7 : 0) })))

    return { n: scan.count, t: n * 5 + (n > forkAt ? 7 : 0), digest: scan.digest, checkpoints: scan.checkpoints, early: scan.early }
  }

  const relationOf = (storedTip, givenTip) => {
    const s = installation()
    const o = installation({ first: 2 })

    seed(s, { entries: [entryOf({ id: 'c1', branches: { b1: storedTip } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }) } })
    seed(o, { entries: [entryOf({ id: 'c1', branches: { b1: givenTip } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [200] } } }) } })

    return plan(s, parsed(exportOf(o))).preview.campaigns[0].files[0].relation
  }

  check('association', 'one tip continues another only when it holds the digest of the whole of the shorter one: a shared checkpoint before a fork proves nothing, so nothing is merged and the stored tip, file and annotations stay', async () => {
    assert.equal(relationOf(tipOf(128), tipOf(192)), 'extends')
    assert.equal(relationOf(tipOf(192), tipOf(128)), 'behind')
    assert.equal(relationOf(tipOf(64), forked(128, 70)), 'extends', 'a fork after the end of the shorter tip is a continuation')
    assert.equal(relationOf(forked(128, 100), tipOf(192)), 'different')
    assert.equal(relationOf(tipOf(100), tipOf(120)), 'unknown', 'no digest covers the 100 increments, so a continuation cannot be told')
    assert.equal(relationOf(tipOf(100), forked(120, 90)), 'unknown', 'a shared checkpoint at 64 does not cover the fork at 90')
    assert.equal(relationOf(forked(120, 90), tipOf(100)), 'unknown')
    assert.equal(relationOf(tipOf(100), forked(100, 90)), 'different')
    assert.equal(relationOf(tipOf(64), forked(128, 40)), 'different', 'the longer tip holds the checkpoint of 64 and it is not the shorter tip\'s')

    const world = annotated()
    const registry = world.a.registry()

    registry.campaigns.c1.branches.b1.tip = forked(120, 90)
    world.a.put('registry', registry)

    const b = installation({ first: 2 })

    seed(b, { entries: [entryOf({ id: 'c1', branches: { b1: forked(100, 100), b2: tipOf(100) } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }), 'c1-b2': fileOf({ races: { 1: { times: [100] } } }) } })

    const envelope = parsed(exportOf(world.a, { annotations: world.annotationsA }))
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } }
    const planned = plan(b, envelope, choices, world.annotationsB(b))
    const [row] = planned.preview.campaigns[0].files

    assert.equal(row.relation, 'unknown')
    assert.equal(row.policy, 'keep')
    assert.ok(row.locked)
    assert.ok(planned.preview.campaigns[0].annotations.groups.filter((group) => group.branchId === 'b1').every((group) => group.locked && group.add === 0))

    const tip = b.registry().campaigns.c1.branches.b1.tip

    await restore(b, envelope, choices, { annotations: world.annotationsB(b) })

    assert.deepEqual(timesOf(b.fileOf('c1', 'b1')), [100], 'the stored file of the branch is untouched')
    assert.deepEqual(b.registry().campaigns.c1.branches.b1.tip, tip, 'and so is its tip')
    assert.deepEqual(world.repositoryB(b).list(world.scope(1, 'b1')), [], 'no annotation of the branch is restored')
  })

  // The disk of `inst` refuses the write of one history file: a restore that reaches it stops there.
  const failOn = (inst, file) => {
    inst.hooks.beforeWrite = (name) => {
      if (name === `file:campaign-${file}`) {
        throw new Error('the disk is full')
      }
    }
  }

  const attemptOn = (inst, envelope, options) => backup.applyRestore({ io: inst.io, envelope, choices: options, expected: plan(inst, envelope, options).digest, confirmed: true, now: inst.now })

  // The same stores read again after a restart.
  const reopen = (inst) => {
    const next = installation()

    inst.files.forEach((value, name) => next.put(name, value))

    return next
  }

  // A campaign c1 on a stored installation and the same one in another, to be restored by replace.
  const failing = () => {
    const { stored, other } = pair()
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' }, b2: { policy: 'replace' } } } } }
    const attempt = (inst, envelope, options = choices) => attemptOn(inst, envelope, options)

    return { stored, other, choices, failOn, attempt, reopen }
  }

  // Two campaigns, c1 (b1 and b2) and c2 (b1), stored and in another installation; `same` leaves the second campaign's history as stored in the backup. `choose` is a restore by replace of the files named, the others kept.
  const twoCampaigns = ({ same = false } = {}) => {
    const s = installation()
    const o = installation({ first: 2 })
    const c1 = entryOf({ id: 'c1', branches: { b1: tipOf(100), b2: tipOf(100) } })
    const c2 = entryOf({ id: 'c2', GameID: 2, key: 2, branches: { b1: tipOf(100) } })
    const plain = (times) => fileOf({ races: { 1: { times } } })
    const policy = (files, name) => ({ policy: files.includes(name) ? 'replace' : 'keep' })
    const choose = ({ c1: first = [], c2: second = [] }) => ({ campaigns: { c1: { files: { b1: policy(first, 'c1-b1'), b2: policy(first, 'c1-b2') } }, c2: { files: { b1: policy(second, 'c2-b1') } } } })

    seed(s, { entries: [c1, c2], files: { 'c1-b1': plain([100, 200]), 'c1-b2': plain([100, 200]), 'c2-b1': plain([100, 200]) } })
    seed(o, { entries: [clone(c1), clone(c2)], files: { 'c1-b1': plain([300]), 'c1-b2': plain([350]), 'c2-b1': plain(same ? [100, 200] : [400]) } })

    return { s, o, choose, plain, was: exportOf(s, { at: 1 }), envelope: parsed(exportOf(o)) }
  }

  check('apply', 'a restore that keeps failing is applied again, also after a restart, and the backup of the history as it was before the first attempt is never aged out; finishing it files that backup', async () => {
    const { stored: first, other, failOn, attempt, reopen, choices } = failing()
    const envelope = parsed(exportOf(other))
    const original = first.fileOf('c1', 'b1')
    const was = exportOf(first, { at: 1 })
    let stored = first

    for (let round = 0; round < backup.KEPT_BACKUPS + 2; round++) {
      failOn(stored, 'c1-b2')
      await assert.rejects(() => attempt(stored, envelope), /disk is full/)

      const held = backup.unfinishedRestore(stored.io)

      assert.ok(held, `the backup is pinned after attempt ${round + 1}`)
      assert.deepEqual(held.envelope.campaigns, was.campaigns, `it is still the history before the first attempt after attempt ${round + 1}`)
      assert.equal(backup.keptBackups(stored.io).length, 0, 'a failed attempt files nothing among the kept backups')
      assert.ok(!timesOf(stored.fileOf('c1', 'b1')).includes(100), 'the live file no longer holds what the first write removed')
      assert.ok(timesOf(held.envelope.campaigns[0].branches.b1).includes(100), 'the pinned backup does')
      stored = reopen(stored)
    }

    stored.hooks.beforeWrite = null

    const done = await attempt(stored, envelope)

    assert.equal(done.applied, true)
    assert.equal(backup.unfinishedRestore(stored.io), null)
    assert.equal(backup.keptBackups(stored.io).length, 1)
    assert.deepEqual(backup.keptBackups(stored.io)[0].envelope.campaigns, was.campaigns)
    assert.equal(done.backup.label, 'before restoring Campaign')

    await restore(stored, parsed(backup.keptBackups(stored.io)[0].envelope), choices)

    assert.deepEqual(stored.fileOf('c1', 'b1'), original, 'restoring the kept backup by replace brings the file back as it was')
  })

  check('apply', 'an unfinished restore is abandoned by the identity shown, a pin that is not that one is refused and left as it is, and the abandoned backup is filed with the others', async () => {
    const { s, choose, was, envelope } = twoCampaigns()
    const first = choose({ c1: ['c1-b1', 'c1-b2'] })

    failOn(s, 'c1-b2')
    await assert.rejects(() => attemptOn(s, envelope, first), /disk is full/)
    s.hooks.beforeWrite = null

    const shown = backup.unfinishedRestore(s.io)
    const before = s.snapshot()

    assert.ok(shown.id, 'a pin has an identity')
    assert.throws(() => backup.abandonRestore(s.io), /not the one that was shown/)
    assert.throws(() => backup.abandonRestore(s.io, 'another'), /not the one that was shown/)
    assert.equal(s.snapshot(), before, 'a refused abandon changes nothing')

    // another window finishes the restore shown and a second one stops part way: its pin is another one
    await attemptOn(s, envelope, first)
    assert.equal(backup.unfinishedRestore(s.io), null)

    const second = choose({ c2: ['c2-b1'] })

    failOn(s, 'c2-b1')
    await assert.rejects(() => attemptOn(s, envelope, second), /disk is full/)
    s.hooks.beforeWrite = null

    const current = backup.unfinishedRestore(s.io)

    assert.notEqual(current.id, shown.id)
    assert.equal(current.key === shown.key, false)
    assert.throws(() => backup.abandonRestore(s.io, shown.id), /not the one that was shown/)
    assert.equal(backup.unfinishedRestore(s.io).id, current.id, 'the newer restore is still unfinished')

    const filed = backup.abandonRestore(s.io, current.id)

    assert.equal(filed.label, 'before restoring Campaign')
    assert.equal(backup.unfinishedRestore(s.io), null)
    assert.equal(backup.keptBackups(s.io).length, 2)
    assert.equal(backup.abandonRestore(s.io, current.id), null, 'nothing is left to abandon')
    assert.deepEqual(backup.keptBackups(s.io)[1].envelope.campaigns, was.campaigns.filter((item) => item.id === 'c1'))
  })

  check('apply', 'a restore that is not the unfinished one is refused while one is unfinished, nothing is written, and no other restore extends, completes or files its backup', async () => {
    const { s, o, choose, was, envelope } = twoCampaigns()
    const first = choose({ c1: ['c1-b1', 'c1-b2'] })

    failOn(s, 'c1-b2')
    await assert.rejects(() => attemptOn(s, envelope, first), /disk is full/)
    s.hooks.beforeWrite = null

    const pinned = backup.unfinishedRestore(s.io)
    const before = s.snapshot()

    assert.deepEqual(pinned.envelope.campaigns, was.campaigns.filter((item) => item.id === 'c1'))

    // the second campaign alone, the same backup with a smaller selection, and another backup of the same campaigns
    o.put('file:campaign-c1-b1', fileOf({ races: { 1: { times: [310] } } }))

    const others = [[envelope, choose({ c2: ['c2-b1'] })], [envelope, choose({ c1: ['c1-b2'] })], [envelope, choose({ c1: ['c1-b1', 'c1-b2'], c2: ['c2-b1'] })], [parsed(exportOf(o)), first]]

    for (let round = 0; round < backup.KEPT_BACKUPS + 1; round++) {
      for (const [given, options] of others) {
        const error = await rejects(() => attemptOn(s, given, options), 'Rejected')

        assert.match(error.message, /did not finish is still kept/)
        assert.match(error.message, /same choices|abandon/)
      }
    }

    assert.equal(s.snapshot(), before, 'nothing was written, the pinned copy and every file are as they were')
    assert.equal(backup.unfinishedRestore(s.io).id, pinned.id)
    assert.equal(backup.keptBackups(s.io).length, 0)

    // a restore with nothing to do neither completes nor files it
    const stored = exportOf(s, { at: 5 })
    const none = await backup.applyRestore({ io: s.io, envelope: parsed(stored), choices: {}, expected: plan(s, parsed(stored), {}).digest, confirmed: true, now: s.now })

    assert.equal(none.applied, false)
    assert.equal(none.backup, null)
    assert.equal(s.snapshot(), before)

    // the restore that was unfinished is finished by applying it again, and then others go on
    const done = await attemptOn(s, envelope, first)

    assert.equal(done.applied, true)
    assert.equal(backup.unfinishedRestore(s.io), null)
    assert.deepEqual(backup.keptBackups(s.io)[0].envelope.campaigns, was.campaigns.filter((item) => item.id === 'c1'))

    const next = await attemptOn(s, envelope, choose({ c2: ['c2-b1'] }))

    assert.equal(next.applied, true)
    assert.equal(backup.keptBackups(s.io).length, 2)
  })

  check('apply', 'a retry of the same restore that now reaches another campaign extends the pinned backup with that campaign as it stands, and finishing it files both', async () => {
    const { s, choose, was, plain, envelope } = twoCampaigns({ same: true })
    const all = choose({ c1: ['c1-b1', 'c1-b2'], c2: ['c2-b1'] })

    failOn(s, 'c1-b2')
    await assert.rejects(() => attemptOn(s, envelope, all), /disk is full/)
    assert.deepEqual(backup.unfinishedRestore(s.io).envelope.campaigns.map((item) => item.id), ['c1'], 'the second campaign needed nothing')

    // its history changes before the retry, so the retry would replace it too
    s.put('file:campaign-c2-b1', plain([100, 200, 250]))
    failOn(s, 'c2-b1')
    await assert.rejects(() => attemptOn(s, envelope, all), /disk is full/)

    const held = backup.unfinishedRestore(s.io)

    assert.deepEqual(held.envelope.campaigns.map((item) => item.id).sort(), ['c1', 'c2'])
    assert.deepEqual(held.envelope.campaigns.find((item) => item.id === 'c1'), was.campaigns.find((item) => item.id === 'c1'), 'the first campaign is the original')
    assert.deepEqual(timesOf(held.envelope.campaigns.find((item) => item.id === 'c2').branches.b1), [100, 200, 250], 'the second as it was when the retry began')

    s.hooks.beforeWrite = null

    const done = await attemptOn(s, envelope, all)

    assert.equal(done.applied, true)
    assert.equal(backup.unfinishedRestore(s.io), null)
    assert.deepEqual(backup.keptBackups(s.io)[0].envelope.campaigns.map((item) => item.id).sort(), ['c1', 'c2'])
  })

  check('apply', 'a restore carried out whose backup could not be filed is finished by applying it again: nothing is left to do, so the kept backup is filed, and no other restore does that', async () => {
    const { s, choose, envelope } = twoCampaigns()
    const first = choose({ c1: ['c1-b1', 'c1-b2'] })
    let seen = 0

    s.hooks.beforeWrite = (name) => {
      if (name === 'backup' && ++seen === 2) {
        throw new Error('the disk is full')
      }
    }

    const error = await rejects(() => attemptOn(s, envelope, first), 'Rejected')

    assert.match(error.message, /could not be filed/)
    s.hooks.beforeWrite = null
    assert.deepEqual(timesOf(s.fileOf('c1', 'b1')), [300], 'the files were written')
    assert.ok(backup.unfinishedRestore(s.io), 'the backup is still unfinished')

    const other = await backup.applyRestore({ io: s.io, envelope, choices: choose({ c1: ['c1-b1'] }), expected: plan(s, envelope, choose({ c1: ['c1-b1'] })).digest, confirmed: true, now: s.now })

    assert.equal(other.backup, null, 'a restore with another selection does not file it')
    assert.ok(backup.unfinishedRestore(s.io))

    const again = await attemptOn(s, envelope, first)

    assert.equal(again.applied, false)
    assert.equal(again.backup.label, 'before restoring Campaign')
    assert.equal(backup.unfinishedRestore(s.io), null)
    assert.equal(backup.keptBackups(s.io).length, 1)
  })

  check('apply', 'a damaged copy kept for an unfinished restore is never reused: a retry, a retry that extends it and a retry with nothing left to do are refused with the stored copy as it is, and abandoning it still works', async () => {
    const damage = (inst) => {
      const store = inst.files.get('backup')

      inst.put('backup', { ...store, unfinished: { ...store.unfinished, envelope: { ...store.unfinished.envelope, digest: 'damaged' } } })
    }

    // a retry that reuses it
    const { s, choose, envelope } = twoCampaigns()
    const first = choose({ c1: ['c1-b1', 'c1-b2'] })

    failOn(s, 'c1-b2')
    await assert.rejects(() => attemptOn(s, envelope, first), /disk is full/)
    s.hooks.beforeWrite = null
    damage(s)

    const before = s.snapshot()
    const reused = await rejects(() => attemptOn(s, envelope, first), 'Rejected')

    assert.match(reused.message, /cannot be read back/)
    assert.equal(s.snapshot(), before, 'nothing was written and the stored copy is as it was')

    // a retry that extends it
    const e = twoCampaigns({ same: true })
    const all = e.choose({ c1: ['c1-b1', 'c1-b2'], c2: ['c2-b1'] })

    failOn(e.s, 'c1-b2')
    await assert.rejects(() => attemptOn(e.s, e.envelope, all), /disk is full/)
    e.s.hooks.beforeWrite = null
    e.s.put('file:campaign-c2-b1', e.plain([100, 200, 250]))
    damage(e.s)

    const extended = e.s.snapshot()

    await rejects(() => attemptOn(e.s, e.envelope, all), 'Rejected')
    assert.equal(e.s.snapshot(), extended)

    // a retry with nothing left to do
    const n = twoCampaigns()
    const done = n.choose({ c1: ['c1-b1', 'c1-b2'] })
    let seen = 0

    n.s.hooks.beforeWrite = (name) => {
      if (name === 'backup' && ++seen === 2) {
        throw new Error('the disk is full')
      }
    }

    await rejects(() => attemptOn(n.s, n.envelope, done), 'Rejected')
    n.s.hooks.beforeWrite = null
    damage(n.s)

    const finished = n.s.snapshot()

    await rejects(() => attemptOn(n.s, n.envelope, done), 'Rejected')
    assert.equal(n.s.snapshot(), finished)
    assert.equal(backup.keptBackups(n.s.io).length, 0)

    // the player can still abandon it, which files the stored copy as it is
    const filed = backup.abandonRestore(n.s.io, backup.unfinishedRestore(n.s.io).id)

    assert.ok(filed)
    assert.equal(backup.unfinishedRestore(n.s.io), null)
    assert.equal(backup.keptBackups(n.s.io)[0].envelope.digest, 'damaged')
  })

  check('apply', 'a stored unfinished restore counts whether or not it can be read: a record damaged in its outer fields is still shown, blocks every restore with the stored record untouched, and is filed by abandoning it, not replaced by a copy of the half-restored history', async () => {
    const damages = {
      'the format of its envelope': { readable: false, damage: (record) => ({ ...record, envelope: { ...record.envelope, format: 'something-else' } }) },
      'its envelope': { readable: false, damage: (record) => ({ ...record, envelope: 'gone' }) },
      everything: { readable: false, damage: () => 'a stray text' },
      'its label': { readable: true, damage: (record) => ({ ...record, label: 7 }) },
      'its time': { readable: true, damage: (record) => ({ ...record, at: 'yesterday' }) },
      'its identity and key': { readable: true, damage: ({ at, label, envelope }) => ({ at, label, envelope }) },
    }

    for (const [what, { readable, damage }] of Object.entries(damages)) {
      const { s, choose, envelope } = twoCampaigns()
      const first = choose({ c1: ['c1-b1', 'c1-b2'] })

      failOn(s, 'c1-b2')
      await assert.rejects(() => attemptOn(s, envelope, first), /disk is full/)
      s.hooks.beforeWrite = null

      const store = s.files.get('backup')
      const stored = damage(store.unfinished)

      s.put('backup', { ...store, unfinished: stored })

      const shown = backup.unfinishedRestore(s.io)

      assert.ok(shown, `a record with ${what} damaged is still an unfinished restore`)
      assert.equal(!!backup.unfinishedProblem(shown), !readable, `the problem of a record with ${what} damaged`)

      const before = s.snapshot()
      const others = [first, choose({ c1: ['c1-b2'] }), choose({ c2: ['c2-b1'] })]

      for (const options of readable ? others.slice(1) : others) {
        const error = await rejects(() => attemptOn(s, envelope, options), 'Rejected')

        assert.match(error.message, /did not finish is still kept|cannot be read back/, what)
      }

      assert.equal(s.snapshot(), before, `nothing was written and the record with ${what} damaged is as it was`)
      assert.deepEqual(s.files.get('backup').unfinished, stored)

      const filed = backup.abandonRestore(s.io, shown.id)

      assert.ok(filed, `a record with ${what} damaged is abandoned by the identity shown`)
      assert.equal(backup.unfinishedRestore(s.io), null)
      assert.equal(backup.keptBackups(s.io).length, 1, `its data is among the kept copies, ${what}`)

      if (what === 'the format of its envelope') {
        assert.equal(backup.keptBackups(s.io)[0].envelope.format, 'something-else')
      }

      if (what === 'everything') {
        assert.equal(backup.keptBackups(s.io)[0].envelope.unreadable, 'a stray text')
      }

      const done = await attemptOn(s, envelope, first)

      assert.equal(done.applied, true, `the restore is applied once the damaged record is abandoned, ${what}`)
      assert.equal(backup.keptBackups(s.io).length, 2)
    }
  })

  check('apply', 'a record that holds no identity of its own is named by what is stored, so an abandon shown for one malformed value never files another that took its place, while the same stored value keeps its name', async () => {
    const s = installation()
    const keep = () => s.files.get('backup') || { version: 1, entries: [] }
    const store = (unfinished) => s.put('backup', { ...keep(), unfinished })

    store('a stray text')

    const first = backup.unfinishedRestore(s.io)

    assert.equal(backup.unfinishedRestore(s.io).id, first.id, 'the same stored value is the same restore')
    store('a stray text')
    assert.equal(backup.unfinishedRestore(s.io).id, first.id, 'also when it is written again')

    // the one shown is abandoned elsewhere and another malformed value takes its place
    assert.ok(backup.abandonRestore(s.io, first.id))
    store(['an', 'array'])

    const second = backup.unfinishedRestore(s.io)

    assert.notEqual(second.id, first.id, 'another stored value is another restore')

    const before = s.snapshot()

    assert.throws(() => backup.abandonRestore(s.io, first.id), /not the one that was shown/)
    assert.equal(s.snapshot(), before, 'nothing was filed')
    assert.deepEqual(backup.unfinishedRestore(s.io).envelope.unreadable, ['an', 'array'])

    // a different value of the same kind, and a different object without an identity
    store(['another', 'array'])
    assert.notEqual(backup.unfinishedRestore(s.io).id, second.id)
    store({ at: 5, label: 'x', envelope: 'one' })

    const object = backup.unfinishedRestore(s.io)

    store({ at: 5, label: 'x', envelope: 'another' })
    assert.notEqual(backup.unfinishedRestore(s.io).id, object.id)
    assert.ok(backup.abandonRestore(s.io, backup.unfinishedRestore(s.io).id))
    assert.equal(backup.unfinishedRestore(s.io), null)
  })

  // A restore by replace of c1, and c9, which the stored installation lacks: when c1's file is written and c9's is not, the retry has no stored campaign left to change.
  const lateCampaign = () => {
    const s = installation()
    const o = installation({ first: 2 })
    const c1 = entryOf({ id: 'c1', branches: { b1: tipOf(100) } })
    const c9 = entryOf({ id: 'c9', GameID: 9, key: 9, branches: { b1: tipOf(100) } })
    const plain = (times) => fileOf({ races: { 1: { times } } })

    seed(s, { entries: [c1], files: { 'c1-b1': plain([100, 200]) } })
    seed(o, { entries: [clone(c1), c9], files: { 'c1-b1': plain([300]), 'c9-b1': plain([100]) } })

    return { s, o, envelope: parsed(exportOf(o)), choices: { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } } }
  }

  check('apply', 'a backup that holds only campaigns not yet stored is refused while a restore is unfinished, with nothing written, and is applied once that restore is finished', async () => {
    const { s, choose, envelope } = twoCampaigns()
    const first = choose({ c1: ['c1-b1', 'c1-b2'] })
    const n = installation({ first: 3 })

    seed(n, { entries: [entryOf({ id: 'c9', GameID: 9, key: 9, branches: { b1: tipOf(100) } })], files: { 'c9-b1': fileOf({ races: { 1: { times: [100] } } }) } })

    const fresh = parsed(exportOf(n))

    failOn(s, 'c1-b2')
    await assert.rejects(() => attemptOn(s, envelope, first), /disk is full/)
    s.hooks.beforeWrite = null

    const planned = plan(s, fresh, {})

    assert.deepEqual(planned.writes.affected, [], 'it touches no stored campaign, so it needs no copy of one')
    assert.equal(planned.preview.nothingToDo, false)

    const pinned = backup.unfinishedRestore(s.io)
    const before = s.snapshot()
    const error = await rejects(() => attemptOn(s, fresh, {}), 'Rejected')

    assert.match(error.message, /did not finish is still kept/)
    assert.equal(s.snapshot(), before, 'its history and its registry record are not written')
    assert.equal(s.registry().campaigns.c9, undefined)
    assert.equal(backup.unfinishedRestore(s.io).id, pinned.id)

    await attemptOn(s, envelope, first)
    assert.equal(backup.unfinishedRestore(s.io), null)

    const done = await attemptOn(s, fresh, {})

    assert.equal(done.applied, true)
    assert.ok(s.registry().campaigns.c9)
  })

  check('apply', 'a retry whose remaining writes reach no stored campaign still finishes the restore it belongs to and files its backup, and a damaged copy refuses it', async () => {
    const world = lateCampaign()

    failOn(world.s, 'c9-b1')
    await assert.rejects(() => attemptOn(world.s, world.envelope, world.choices), /disk is full/)
    world.s.hooks.beforeWrite = null
    assert.deepEqual(timesOf(world.s.fileOf('c1', 'b1')), [300], 'the stored campaign was written before the failure')
    assert.ok(backup.unfinishedRestore(world.s.io))
    assert.deepEqual(plan(world.s, world.envelope, world.choices).writes.affected, [], 'nothing stored is left to change')

    // the pinned copy is damaged: refused, nothing written, and left where it is
    const damaged = reopen(world.s)
    const store = damaged.files.get('backup')

    damaged.put('backup', { ...store, unfinished: { ...store.unfinished, envelope: { ...store.unfinished.envelope, digest: 'damaged' } } })

    const before = damaged.snapshot()
    const error = await rejects(() => attemptOn(damaged, world.envelope, world.choices), 'Rejected')

    assert.match(error.message, /cannot be read back/)
    assert.equal(damaged.snapshot(), before)

    const done = await attemptOn(world.s, world.envelope, world.choices)

    assert.equal(done.applied, true)
    assert.equal(done.backup.label, 'before restoring Campaign')
    assert.equal(backup.unfinishedRestore(world.s.io), null, 'the restore it protected is finished, so it is no longer unfinished')
    assert.equal(backup.keptBackups(world.s.io).length, 1)
    assert.ok(world.s.registry().campaigns.c9)
  })

  check('apply', 'a kept copy is named by the time it was kept, whatever its envelope holds, where the name of a backup cannot be made from a damaged one', async () => {
    const { was } = twoCampaigns()
    const kept = Date.UTC(2026, 9, 14, 4, 12, 58)
    const broken = { exportedAt: 'broken', campaigns: 'none' }

    assert.throws(() => backup.backupFileName(broken), 'the name of a backup depends on what is inside it')
    assert.equal(backup.recoveryFileName({ at: kept, label: 'x', envelope: was }), 'aurora-history-before-restore-2026-10-14-04-12-58-utc.json')
    assert.equal(backup.recoveryFileName({ at: kept, label: 'x', envelope: broken }), 'aurora-history-before-restore-2026-10-14-04-12-58-utc.json')
    assert.equal(backup.recoveryFileName({ at: kept, label: 'x', envelope: { unreadable: 'text' } }), 'aurora-history-before-restore-2026-10-14-04-12-58-utc.json')
    assert.equal(backup.recoveryFileName({ at: 'late', envelope: broken }), 'aurora-history-before-restore-unknown-time.json')
    assert.equal(backup.recoveryFileName({ at: 1e20, envelope: broken }), 'aurora-history-before-restore-unknown-time.json')
    assert.equal(backup.recoveryFileName(null), 'aurora-history-before-restore-unknown-time.json')
  })

  check('annotations', 'two campaigns may hold one annotation uuid, which the repository\'s own import with kept uuids makes, and all of them are exported, while a campaign that holds one twice is still refused', async () => {
    const world = annotated()
    const second = entryOf({ id: 'c2', GameID: 2, key: 2, branches: { b1: tipOf(100) } })
    const registry = world.a.registry()

    registry.campaigns.c2 = second
    world.a.put('registry', registry)
    world.a.put('file:campaign-c2-b1', fileOf({ races: { 1: { times: [100] } } }))

    const source = world.scope(1, 'b1')
    const bundle = world.repositoryA.exportRecords(source)
    const target = { campaignId: 'c2', RaceID: 1, branch: 'b1' }
    const copied = world.repositoryA.importRecords(bundle, target, { preview: world.repositoryA.previewImport(bundle, target, { keepUuids: true }), keepUuids: true })

    assert.deepEqual(copied.imported.map((record) => record.uuid), bundle.records.map((record) => record.uuid), 'the uuids are kept in the other campaign')

    const everything = exportOf(world.a, { annotations: world.annotationsA })
    const uuids = (id) => everything.campaigns.find((item) => item.id === id).annotations.flatMap((item) => item.records.map((record) => record.uuid))

    assert.ok(uuids('c1').some((uuid) => uuids('c2').includes(uuid)))
    assert.equal(parsed(everything).campaigns.length, 2)

    const doc = JSON.parse(JSON.stringify(everything))
    const group = doc.campaigns.find((item) => item.id === 'c2').annotations.find((item) => item.records.length)

    group.records.push(clone(group.records[0]))
    assert.match(backup.parseBackup(sealed(JSON.stringify(doc))).errors[0], /more than once/)
  })

  // A history file of `races` many races of two thousand snapshots, each with the most installation types a snapshot may carry: more than a backup is read at.
  const bulky = (races) => {
    const fat = Object.fromEntries(Array.from({ length: backup.LIMITS.installations }, (_, index) => [1000 + index, 123456789012]))

    return { gameName: 'Campaign', races: Object.fromEntries(Array.from({ length: races }, (_, index) => [index + 1, { raceName: 'Terran', npr: false, snapshots: Array.from({ length: history.MAX_SNAPSHOTS }, (__, step) => snapshot((step + 1) * 100, { installations: fat })) }])) }
  }

  check('rejection', 'a history too large to be read back as a backup is refused when it is exported and before a restore replaces anything: the safety copy is never one the app could not restore', async () => {
    const stored = installation()
    const other = installation({ first: 2 })
    const entry = entryOf({ id: 'c1', branches: { b1: tipOf(100) } })

    seed(stored, { entries: [entry], files: { 'c1-b1': bulky(3) } })
    seed(other, { entries: [clone(entry)], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }) } })

    const error = (() => {
      try {
        exportOf(stored)
      } catch (thrown) {
        return thrown
      }

      return null
    })()

    assert.ok(error && error.name === 'Rejected', 'the export is refused')
    assert.match(error.message, /larger than 50 MB/)

    const envelope = parsed(exportOf(other))
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } }
    const planned = plan(stored, envelope, choices)
    const before = stored.snapshot()

    assert.ok(planned.preview.totals.removed > 0, 'the replace would remove history')

    const refused = await rejects(() => backup.applyRestore({ io: stored.io, envelope, choices, expected: planned.digest, confirmed: true, now: stored.now }), 'Rejected')

    assert.match(refused.message, /larger than 50 MB/)
    assert.equal(stored.snapshot(), before, 'nothing was written')
    assert.equal(backup.unfinishedRestore(stored.io), null)
  })

  check('rejection', 'the size a backup may have is its bytes as written, not its characters', () => {
    const body = JSON.stringify('\u20AC'.repeat(18000000))

    assert.ok(body.length < backup.MAX_BYTES)
    assert.match(backup.parseBackup(body).errors[0], /larger than 50 MB/)
  })

  check('apply', 'a preview is bound to the stored state it was made from, and to the counts it showed: history that arrived since is not removed under the confirmation already given', async () => {
    const { stored, other } = pair()
    const envelope = parsed(exportOf(other))
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } }
    const planned = plan(stored, envelope, choices)

    assert.ok(planned.preview.needsConfirmation.length > 0)

    const removed = planned.preview.totals.removed
    const file = stored.fileOf('c1', 'b1')

    file.races[1].snapshots.push(snapshot(700))
    stored.put('file:campaign-c1-b1', file)

    const before = stored.snapshot()

    await rejects(() => backup.applyRestore({ io: stored.io, envelope, choices, expected: planned.digest, confirmed: true, now: stored.now }), 'Changed')
    assert.equal(stored.snapshot(), before)
    assert.equal(plan(stored, envelope, choices).preview.totals.removed, removed + 1, 'the new preview shows the snapshot that would go')
  })

  check('annotations', 'a history that changes while the annotation files are waited for is not restored over: the plan is made again and the restore refused as changed, with nothing written', async () => {
    const world = annotated()
    const b = installation({ first: 2 })

    seed(b, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(100), b2: tipOf(100) } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [50] } } }), 'c1-b2': fileOf({ races: { 1: { times: [50] } } }) } })

    const envelope = parsed(exportOf(world.a, { annotations: world.annotationsA }))
    const adapter = world.annotationsB(b)
    const waiting = {
      ...adapter,
      writable: async (id) => {
        b.put('file:campaign-c1-b1', fileOf({ races: { 1: { times: [50, 60] } } }))

        return adapter.writable(id)
      },
    }
    const planned = plan(b, envelope, {}, waiting)
    const writes = b.writes.length

    assert.ok(planned.preview.totals.annotations > 0, 'there are annotations to restore, so the files are waited for')
    await rejects(() => backup.applyRestore({ io: b.io, envelope, expected: planned.digest, confirmed: true, now: b.now, annotations: waiting }), 'Changed')
    assert.equal(b.writes.length, writes, 'nothing was written')
    assert.equal(b.files.has('scenario-c1'), false)
  })

  check('annotations', 'a backup that holds an annotation twice is refused, and a record stored or deleted after the plan was made is neither copied nor brought back', async () => {
    const world = annotated()
    const text = JSON.stringify(exportOf(world.a, { annotations: world.annotationsA }))
    const doc = JSON.parse(text)

    doc.campaigns[0].annotations.push(clone(doc.campaigns[0].annotations[0]))

    const twice = backup.parseBackup(sealed(JSON.stringify(doc)))

    assert.ok(twice.errors, 'a backup repeating a bundle is refused')
    assert.match(twice.errors[0], /more than once/)

    const duplicate = JSON.parse(text)
    const group = duplicate.campaigns[0].annotations.find((item) => item.records.length > 1)

    group.records[1] = clone(group.records[0])
    assert.match(backup.parseBackup(sealed(JSON.stringify(duplicate))).errors[0], /more than once/)

    const b = installation({ first: 2 })
    const envelope = parsed(JSON.parse(text))
    const adapter = world.annotationsB(b)
    const repoB = world.repositoryB(b)
    const where = world.scope(1, 'b1')
    const [first, second, third] = world.notes.filter((note) => note.RaceID === 1 && note.branch === 'b1')
    const bundle = envelope.campaigns[0].annotations.find((item) => item.source.RaceID === 1 && item.source.branchId === 'b1')
    const target = { campaignId: 'c1', RaceID: 1, branch: 'b1' }
    const only = (note) => ({ ...bundle, records: bundle.records.filter((record) => record.uuid === note.uuid) })
    const put = (note) => repoB.importRecords(only(note), target, { preview: repoB.previewImport(only(note), target, { restore: true }), restore: true })
    let fired = false

    const guard = () => {
      if (!fired && b.writes.filter((name) => name.startsWith('file:')).length === 2) {
        fired = true
        put(first)
        put(second)
        repoB.delete(where, second.uuid, 1)
      }
    }

    const planned = plan(b, envelope, {}, adapter)
    const { imports } = await backup.applyRestore({ io: b.io, envelope, expected: planned.digest, confirmed: true, now: b.now, guard, annotations: adapter })

    assert.equal(fired, true)
    assert.equal(imports > 0, true)

    const mine = Object.values(b.files.get('scenario-c1').records).filter((record) => record.RaceID === 1 && record.association.branchId === 'b1')

    assert.deepEqual(mine.map((record) => record.uuid).sort(), [first.uuid, third.uuid].sort(), 'one record of each uuid, and none for the deleted one')
    assert.ok(Object.keys(b.files.get('scenario-c1').tombstones).includes(second.uuid))
  })

  check('rejection', 'an annotation whose campaign, race or branch is not those of the bundle it is in is refused, never rebound', () => {
    const world = annotated()
    const text = JSON.stringify(exportOf(world.a, { annotations: world.annotationsA }))

    ;[(record) => { record.campaignId = 'different-campaign' }, (record) => { record.RaceID = 99 }, (record) => { record.association.branchId = 'b99' }].forEach((edit) => {
      const doc = JSON.parse(text)

      edit(doc.campaigns[0].annotations[0].records[0])

      const out = backup.parseBackup(sealed(JSON.stringify(doc)))

      assert.ok(out.errors, 'refused')
      assert.match(out.errors[0], /belongs to another campaign, race or branch/)
    })
  })

  check('rejection', 'a backup whose unit maps are empty or lack the declaration of one figure is refused, whatever its digest', () => {
    const world = annotated()
    const text = JSON.stringify(exportOf(world.a, { annotations: world.annotationsA }))
    const edits = [
      (units) => { units.race = {} },
      (units) => { units.intelligence = {} },
      (units) => { delete units.race.population },
      (units) => { delete units.intelligence.points },
    ]

    edits.forEach((edit) => {
      const doc = JSON.parse(text)

      edit(doc.units)

      const out = backup.parseBackup(JSON.stringify(doc))

      assert.ok(out.errors, 'refused')
      assert.match(out.errors[0], /units of the figure \w+ are not stated/)
    })
  })

  check('policy', 'replace also removes the series the backup lacks, of the owners chosen, and counts them: a restore that added a race and an intelligence series is undone by replacing from its kept backup', async () => {
    const stored = installation()
    const other = installation({ first: 2 })
    const entry = entryOf({ id: 'c1', branches: { b1: tipOf(100) } })

    seed(stored, { entries: [entry], files: { 'c1-b1': fileOf({ races: { 1: { times: [100, 200] }, 2: { times: [100] } }, intel: { 1: { 2: { times: [100] } } } }) } })
    seed(other, { entries: [clone(entry)], files: { 'c1-b1': fileOf({ races: { 1: { times: [300] }, 3: { times: [100, 150, 160] } }, intel: { 1: { 3: { times: [100, 150] } }, 3: { 1: { times: [100] } } } }) } })

    const original = stored.fileOf('c1')
    const merged = await restore(stored, parsed(exportOf(other)))

    assert.equal(merged.result.applied, true)
    assert.ok(stored.fileOf('c1').races[3] && stored.fileOf('c1').intel[1][3], 'the merge added a race and an intelligence series')

    const [kept] = backup.keptBackups(stored.io)
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } }
    const planned = plan(stored, parsed(kept.envelope), choices)

    assert.equal(planned.preview.totals.removed, 3 + 2 + 1 + 1, 'what the merge added is counted among what would be removed: race 3 (3 snapshots), what race 1 knows of race 3 (2), what race 3 knows of race 1 (1) and the snapshot of race 1 the merge added (1)')
    assert.ok(planned.preview.needsConfirmation.length > 0)
    assert.ok(planned.preview.campaigns[0].files[0].series.some((row) => row.removed > 0))

    await restore(stored, parsed(kept.envelope), choices)

    assert.deepEqual(stored.fileOf('c1'), original, 'the file is back as it was, series and all')

    // an owner that is not chosen keeps its series, though the backup lacks them
    const second = installation({ first: 3 })

    seed(second, { entries: [clone(entry)], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] }, 2: { times: [100, 300] }, 3: { times: [5] } } }) } })

    await restore(second, parsed(exportOf(other)), { campaigns: { c1: { files: { b1: { policy: 'replace', races: ['1'] } } } } })

    assert.deepEqual(timesOf(second.fileOf('c1'), 1), [300])
    assert.deepEqual(timesOf(second.fileOf('c1'), 2), [100, 300], 'race 2 was not chosen')
    assert.deepEqual(timesOf(second.fileOf('c1'), 3), [5], 'neither was race 3')
  })

  // ---- colony series ----

  const colonySnapshot = (t, base = 1) => colony.colonySnapshot({ t, n: t, colonies: [[7, 0, ...Array(14).fill(base)], [9, 1]] })

  // A colony file: `races` is { [RaceID]: times }, a time being a number or [t, base] for a snapshot whose figures differ.
  const colonyFile = (races) => ({ columns: [...colony.COLONY_COLUMNS], races: Object.fromEntries(Object.entries(races).map(([RaceID, times]) => [RaceID, { snapshots: times.map((time) => (Array.isArray(time) ? colonySnapshot(time[0], time[1]) : colonySnapshot(time))) }])) })

  const colonyOf = (inst, branchId = 'b1') => clone(inst.files.get(`file:campaign-c1-${branchId}-colonies`))

  const colonyTimes = (file, RaceID = 1) => (file && file.races[RaceID] ? file.races[RaceID].snapshots.map((item) => item.t) : [])

  const colonyWrites = (inst) => inst.writes.filter((name) => name.endsWith('-colonies'))

  // A backup as one made before colony coverage was recorded (version 1): no `colonyCoverage`, the digest sealed again.
  const uncovered = (envelope) => {
    const doc = JSON.parse(textOf(envelope))

    doc.version = 1
    doc.campaigns.forEach((item) => { delete item.colonyCoverage; delete item.eventCoverage; delete item.events })
    doc.digest = campaign.hashValue(doc.campaigns)

    return parsed(doc)
  }

  const withColonies = (stored, other) => {
    stored.put('file:campaign-c1-b1-colonies', colonyFile({ 1: [100, 200, 300], 2: [100] }))
    stored.put('file:campaign-c1-b2-colonies', colonyFile({ 1: [100] }))
    other.put('file:campaign-c1-b1-colonies', colonyFile({ 1: [[200, 5], 400] }))
    other.put('file:campaign-c1-b2-colonies', colonyFile({ 1: [500] }))
  }

  check('colonies', 'the colony series of each branch go into the backup beside its history and come back exactly in an empty installation, each branch apart from the others; an installation without colony series gives a backup with none', async () => {
    const { stored, other } = pair()

    stored.put('file:campaign-c1-b1-colonies', colonyFile({ 1: [100, 200, 300], 2: [100] }))
    stored.put('file:campaign-c1-b2-colonies', colonyFile({ 1: [100, 200] }))

    assert.equal(Object.keys(parsed(exportOf(other)).campaigns[0]).includes('colonies'), false)
    assert.equal(parsed(exportOf(other)).campaigns[0].colonyCoverage, true, 'a backup says it records the colony files, so that none is a known state')

    const envelope = parsed(exportOf(stored))

    assert.deepEqual(Object.keys(envelope.campaigns[0].colonies).sort(), ['b1', 'b2'])
    assert.deepEqual(envelope.campaigns[0].colonies.b1, colonyOf(stored, 'b1'))

    const empty = installation({ first: 3 })
    const planned = plan(empty, envelope)

    assert.equal(planned.preview.campaigns[0].files[0].colonies.status, 'new')
    assert.equal(planned.preview.campaigns[0].files[0].colonies.totals.added, 4)

    await restore(empty, envelope)

    assert.deepEqual(colonyOf(empty, 'b1'), colonyOf(stored, 'b1'))
    assert.deepEqual(colonyOf(empty, 'b2'), colonyOf(stored, 'b2'))
    assert.deepEqual(colonyTimes(colonyOf(empty, 'b2')), [100, 200], 'the second branch has its own series, not the first\'s')
    assert.equal(plan(empty, envelope).preview.nothingToDo, true)

    // every state of a colony, an observed one with its figures, a failed read and a colony another race holds, comes back as it was
    const states = installation({ first: 4 })
    const rich = installation({ first: 5 })

    seed(rich, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(100) } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }), 'c1-b1-colonies': { columns: [...colony.COLONY_COLUMNS], races: { 1: { snapshots: [colony.colonySnapshot({ t: 100, n: 100, colonies: [[7, 0, ...Array(14).fill(null).map((_, index) => (index % 2 ? index : null))], [8, 1], [9, 2, 12], [10, 3], [11, 4]], revised: true })] } } } } })

    await restore(states, parsed(exportOf(rich)))

    assert.deepEqual(colonyOf(states), colonyOf(rich))
  })

  check('colonies', 'a backup made before colony coverage was recorded restores over stored colony series without touching them, under every policy, and its preview shows no colony row', async () => {
    const { stored, other } = pair()

    withColonies(stored, installation({ first: 6 }))

    const before = [colonyOf(stored, 'b1'), colonyOf(stored, 'b2')]
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' }, b2: { policy: 'merge' } } } } }
    const planned = plan(stored, uncovered(exportOf(other)), choices)

    assert.ok(planned.preview.campaigns[0].files.every((row) => row.colonies === undefined))

    const { result } = await restore(stored, uncovered(exportOf(other)), choices)

    assert.equal(result.applied, true)
    assert.deepEqual(timesOf(stored.fileOf('c1', 'b1')), [200, 300, 400, 500], 'the history was restored')
    assert.deepEqual([colonyOf(stored, 'b1'), colonyOf(stored, 'b2')], before)
    assert.deepEqual(colonyWrites(stored), [])
  })

  check('colonies', 'the colony series of a branch are merged, replaced or kept by the policy of its history file and the races chosen: a merge keeps the stored snapshot at a shared time and counts the conflict, a replace of a backup with coverage takes its state and one without keeps the series it lacks', async () => {
    const { stored, other } = pair()

    withColonies(stored, other)

    const choices = { campaigns: { c1: { files: { b1: { policy: 'merge' }, b2: { policy: 'replace' } } } } }
    const planned = plan(stored, parsed(exportOf(other)), choices)
    const [b1, b2] = planned.preview.campaigns[0].files

    assert.equal(b1.colonies.policy, 'merge')
    assert.equal(b1.colonies.totals.conflicts, 1)
    assert.equal(b1.colonies.totals.added, 1)
    assert.equal(b1.colonies.totals.identical, 0)
    assert.equal(b1.colonies.status, 'changes')
    assert.ok(b1.colonies.series.every((row) => row.label.startsWith('colonies of race')))
    assert.equal(b2.colonies.policy, 'replace')
    assert.equal(b2.colonies.totals.removed, 1)
    assert.ok(planned.preview.needsConfirmation.length > 0)

    const before = stored.snapshot()

    plan(stored, parsed(exportOf(other)), choices)

    assert.equal(stored.snapshot(), before, 'a preview writes nothing')

    const kept = colonyOf(stored, 'b1').races[1].snapshots[1]

    await restore(stored, parsed(exportOf(other)), choices)

    assert.deepEqual(colonyTimes(colonyOf(stored, 'b1')), [100, 200, 300, 400])
    assert.deepEqual(colonyOf(stored, 'b1').races[1].snapshots[1], kept, 'the stored snapshot at the shared time stays')
    assert.deepEqual(colonyTimes(colonyOf(stored, 'b1'), 2), [100], 'a race the backup lacks keeps its series under a merge')
    assert.deepEqual(colonyTimes(colonyOf(stored, 'b2')), [500], 'a replace takes the backup\'s series')

    // a replace of a backup that records its colony files drops a stored series it lacks, and a keep leaves the file as it is
    const second = pair()

    withColonies(second.stored, second.other)
    second.stored.put('file:campaign-c1-b2-colonies', colonyFile({ 1: [100], 2: [100, 150] }))

    const replaced = { campaigns: { c1: { files: { b1: { policy: 'replace' }, b2: { policy: 'keep' } } } } }
    const b2Before = colonyOf(second.stored, 'b2')

    await restore(second.stored, parsed(exportOf(second.other)), replaced)

    assert.deepEqual(colonyTimes(colonyOf(second.stored, 'b1')), [200, 400])
    assert.deepEqual(colonyTimes(colonyOf(second.stored, 'b1'), 2), [], 'a replace takes the state a covered backup records: it has no series of race 2')
    assert.deepEqual(colonyOf(second.stored, 'b2'), b2Before)
    assert.deepEqual(colonyWrites(second.stored), ['file:campaign-c1-b1-colonies'])

    // one made before coverage says nothing about a series it lacks, so a replace keeps it
    const legacy = pair()

    withColonies(legacy.stored, legacy.other)
    await restore(legacy.stored, uncovered(exportOf(legacy.other)), replaced)

    assert.deepEqual(colonyTimes(colonyOf(legacy.stored, 'b1')), [200, 400])
    assert.deepEqual(colonyTimes(colonyOf(legacy.stored, 'b1'), 2), [100], 'a replace never drops a colony series a backup without coverage lacks')

    const third = pair()

    withColonies(third.stored, third.other)

    const chosen = { campaigns: { c1: { files: { b1: { policy: 'merge', races: ['2'] }, b2: { policy: 'keep' } } } } }
    const b1Before = colonyOf(third.stored, 'b1')

    await restore(third.stored, parsed(exportOf(third.other)), chosen)

    assert.deepEqual(colonyOf(third.stored, 'b1'), b1Before, 'race 1 was not chosen')
  })

  check('colonies', 'a branch whose timeline is not the stored one keeps its colony series, shown as kept with the reason', async () => {
    const stored = installation()
    const other = installation({ first: 2 })

    seed(stored, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(150) } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }), 'c1-b1-colonies': colonyFile({ 1: [100, 200] }) } })
    seed(other, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(150, 7) } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [200] } } }), 'c1-b1-colonies': colonyFile({ 1: [300] }) } })

    const before = stored.snapshot()
    const planned = plan(stored, parsed(exportOf(other)), { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } })
    const [row] = planned.preview.campaigns[0].files

    assert.match(row.colonies.locked, /different timeline/)
    assert.equal(row.colonies.policy, 'keep')
    assert.equal(row.colonies.status, 'kept')

    await restore(stored, parsed(exportOf(other)))

    assert.equal(stored.snapshot(), before)

    // a stored colony file this version cannot read is shown as kept with the reason, and the restore is refused whole, because a safety copy that covers the colony files cannot be made of it
    const damaged = pair()

    withColonies(damaged.stored, damaged.other)
    damaged.stored.put('file:campaign-c1-b1-colonies', { races: 5 })

    const [shown] = plan(damaged.stored, parsed(exportOf(damaged.other))).preview.campaigns[0].files

    assert.match(shown.colonies.locked, /not one this version reads/)
    assert.equal(shown.colonies.status, 'kept')

    const damagedBefore = damaged.stored.snapshot()
    const stopped = await rejects(() => restore(damaged.stored, parsed(exportOf(damaged.other))), 'Rejected')

    assert.match(stopped.message, /colony series of branch b1 of campaign c1 cannot be read/)
    assert.equal(damaged.stored.snapshot(), damagedBefore, 'nothing was written, and the damaged file is as it was')
  })

  check('colonies', 'a backup whose colony series are malformed is refused whatever its digest: a branch the campaign lacks, other columns, a key not read, a bad race id, times or colonies out of order, a state without its values, a bad thinning record', async () => {
    const colonied = (change) => {
      const { stored } = pair()

      stored.put('file:campaign-c1-b1-colonies', colonyFile({ 1: [100, 200], 2: [100] }))

      const doc = JSON.parse(textOf(exportOf(stored)))

      change(doc.campaigns[0].colonies, doc)

      return sealed(JSON.stringify(doc))
    }

    refused(colonied((colonies) => { colonies.b9 = colonies.b1 }), /not a map of the branches/)
    refused(colonied((_colonies, doc) => { doc.campaigns[0].colonies = {} }), /not a map of the branches/)
    refused(colonied((colonies) => { colonies.b1.columns.reverse() }), /columns are not the figures/)
    refused(colonied((colonies) => { colonies.b1.extra = 1 }), /holds extra, which this version does not read/)
    refused(colonied((colonies) => { colonies.b1.races.x = colonies.b1.races[1] }), /not a series under a race id/)
    refused(colonied((colonies) => { colonies.b1.races[1].snapshots[1].t = colonies.b1.races[1].snapshots[0].t }), /not later than the one before it/)
    refused(colonied((colonies) => { colonies.b1.races[1].snapshots[0].colonies.reverse() }), /not after the one before it/)
    refused(colonied((colonies) => { colonies.b1.races[1].snapshots[0].colonies[0][1] = 9 }), /is not a colony/)
    refused(colonied((colonies) => { colonies.b1.races[1].snapshots[0].colonies[0] = [7, 0, 1] }), /is not a colony/)
    refused(colonied((colonies) => { colonies.b1.races[1].snapshots[0].colonies[1] = [9, 1, 5] }), /is not a colony/)
    refused(colonied((colonies) => { colonies.b1.races[1].thinning = { bad: true } }), /thinning record is not valid/)
    refused(colonied((colonies) => { colonies.b1.races[1].snapshots[0].extra = 1 }), /holds extra/)
    refused(colonied((colonies) => { colonies.b1.races[1].snapshots[0].revised = false }), /marks a revision that is not true/)
    refused(colonied((_colonies, doc) => { doc.campaigns[0].colonyCoverage = false }), /colony coverage is not true/)
    refused(colonied((_colonies, doc) => { delete doc.campaigns[0].colonyCoverage }), /colony coverage is not true/)
    refused(colonied((_colonies, doc) => { doc.version = 1 }), /holds colonyCoverage, which a version 1 backup does not state/)
    assert.equal(backup.parseBackup(colonied(() => {})).errors, undefined)
  })

  check('colonies', 'a backup says it covers the colony files; a version 1 backup is read as before and never says so, and a backup from version 2 on without the statement is refused', async () => {
    const { stored } = pair()

    stored.put('file:campaign-c1-b1-colonies', colonyFile({ 1: [100] }))

    const envelope = parsed(exportOf(stored))

    assert.ok(backup.VERSION >= backup.COLONY_COVERAGE_VERSION)
    assert.equal(envelope.version, backup.VERSION)
    assert.ok(envelope.campaigns.every((item) => item.colonyCoverage === true))

    const old = uncovered(envelope)

    assert.equal(old.version, 1)
    assert.equal(old.campaigns[0].colonyCoverage, undefined)
    assert.deepEqual(Object.keys(old.campaigns[0].colonies), ['b1'])

    const doc = JSON.parse(textOf(envelope))

    delete doc.campaigns[0].colonyCoverage
    refused(sealed(JSON.stringify(doc)), /colony coverage is not true/)
  })

  check('colonies', 'a stored colony file this version cannot read is never left out of a backup that says it covers the colony files: the export and the safety copy are refused naming the branch and nothing is written, while a store that is not there is covered as none', async () => {
    const readable = colonyFile({ 1: [100, 200] })
    const broken = [{ ...readable, races: 5 }, { ...readable, columns: ['population'] }, { ...readable, extra: 1 }, { columns: readable.columns }, { ...readable, races: { x: readable.races[1] } }, 'text', 7]

    for (const file of broken) {
      const { stored, other } = pair()

      stored.put('file:campaign-c1-b1-colonies', readable)
      stored.put('file:campaign-c1-b2-colonies', file)

      const refusal = await rejects(async () => exportOf(stored), 'Rejected')

      assert.match(refusal.message, /colony series of branch b2 of campaign c1 cannot be read/, JSON.stringify(file))

      const before = stored.snapshot()
      const stopped = await rejects(() => restore(stored, parsed(exportOf(other))), 'Rejected')

      assert.match(stopped.message, /backup of the current history could not be made.*colony series of branch b2 of campaign c1 cannot be read/, JSON.stringify(file))
      assert.equal(stored.snapshot(), before, 'nothing was written')
    }

    const empty = pair().stored

    empty.put('file:campaign-c1-b1-colonies', {})

    const exported = parsed(exportOf(empty))

    assert.equal(exported.campaigns[0].colonyCoverage, true)
    assert.equal(exported.campaigns[0].colonies, undefined, 'a store with nothing in it is no colony file')
  })

  check('colonies', 'a preview of colony series writes nothing, counts them as files with the history\'s, and a restore writes exactly the files the preview counted', async () => {
    const { stored, other } = pair()

    withColonies(stored, other)

    const choices = { campaigns: { c1: { files: { b1: { policy: 'merge' }, b2: { policy: 'merge' } } } } }
    const before = stored.snapshot()
    const planned = plan(stored, parsed(exportOf(other)), choices)

    assert.equal(stored.snapshot(), before)
    assert.equal(planned.preview.totals.files, 4, 'two history files and two colony files change')
    assert.ok(planned.preview.totals.conflicts >= 1)
    assert.equal(planned.preview.totals.conflicts, planned.preview.campaigns[0].files.reduce((sum, row) => sum + row.totals.conflicts + row.colonies.totals.conflicts, 0), 'the conflicts of the history files and of the colony series')

    const { result } = await restore(stored, parsed(exportOf(other)), choices)

    assert.equal(result.files, 4)
    assert.equal(colonyWrites(stored).length, 2)
  })

  check('colonies', 'a restore of colony series is undone from its safety copy: the copy holds the colony series as they were, and restoring it with Replace brings them back', async () => {
    const { stored, other } = pair()

    withColonies(stored, other)

    const original = colonyOf(stored, 'b1')
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } }

    await restore(stored, parsed(exportOf(other)), choices)

    assert.deepEqual(colonyTimes(colonyOf(stored, 'b1')), [200, 400])

    const [held] = backup.keptBackups(stored.io)

    assert.deepEqual(held.envelope.campaigns[0].colonies.b1, original)

    await restore(stored, parsed(held.envelope), choices)

    assert.deepEqual(colonyOf(stored, 'b1'), original)
  })

  check('colonies', 'a safety copy taken before a restore that adds colony series restores them away again with Replace: from a branch with no colony file the file is emptied, from one with a file that lacked a newly imported race the race is removed, and nothing is shown or written where neither side holds colony series', async () => {
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } }

    // no colony series on either side: nothing to restore
    const bare = pair()
    const quiet = plan(bare.stored, parsed(exportOf(bare.other)), choices)

    assert.ok(quiet.preview.campaigns[0].files.every((row) => row.colonies === undefined))
    assert.equal(colonyWrites(bare.stored).length, 0)

    // a branch with no colony file takes a restore that adds one
    const { stored, other } = pair()

    other.put('file:campaign-c1-b1-colonies', colonyFile({ 1: [200, 400] }))
    await restore(stored, parsed(exportOf(other)))

    assert.deepEqual(colonyTimes(colonyOf(stored, 'b1')), [200, 400])

    const [held] = backup.keptBackups(stored.io)

    assert.equal(held.envelope.campaigns[0].colonyCoverage, true)
    assert.equal(held.envelope.campaigns[0].colonies, undefined, 'the copy has no colony file to hold')

    const planned = plan(stored, parsed(held.envelope), choices)

    assert.equal(planned.preview.nothingToDo, false)
    assert.equal(planned.preview.campaigns[0].files[0].colonies.totals.removed, 2)

    await restore(stored, parsed(held.envelope), choices)

    assert.deepEqual(colonyOf(stored, 'b1'), {}, 'the colony file is as it was: none')
    assert.equal(plan(stored, parsed(held.envelope), choices).preview.nothingToDo, true)

    // a branch with a colony file that lacked a race the restore imported
    const second = pair()

    second.stored.put('file:campaign-c1-b1-colonies', colonyFile({ 1: [100] }))
    second.other.put('file:campaign-c1-b1-colonies', colonyFile({ 1: [100], 2: [300] }))

    const original = colonyOf(second.stored, 'b1')

    await restore(second.stored, parsed(exportOf(second.other)))

    assert.deepEqual(colonyTimes(colonyOf(second.stored, 'b1'), 2), [300])

    const [again] = backup.keptBackups(second.stored.io)

    await restore(second.stored, parsed(again.envelope), choices)

    assert.deepEqual(colonyOf(second.stored, 'b1'), original)

    // a Merge of the copy changes nothing: it adds, it never removes
    const third = pair()

    third.other.put('file:campaign-c1-b1-colonies', colonyFile({ 1: [200] }))
    await restore(third.stored, parsed(exportOf(third.other)))

    const [copy] = backup.keptBackups(third.stored.io)
    const kept = colonyOf(third.stored, 'b1')

    await restore(third.stored, parsed(copy.envelope))

    assert.deepEqual(colonyOf(third.stored, 'b1'), kept)
  })

  // ---- event archives ----

  // One group of identical rows of an increment's events: the nine fields of an event and how many identical rows there were.
  const eventGroup = (id, tag, count) => [id * 5, 3, `${tag} ${id}`, 12, null, null, null, 0, 0, count]

  // An event record of a race: `ids` the increments that hold events of it, `tag` what the events say and `count` how many identical rows each increment holds.
  const eventRecord = (ids, tag = 'event', count = 1) => ({ increments: ids.map((id) => [id, id * 5, 5, [eventGroup(id, tag, count)]]), spans: [[ids[0] * 5, ids[ids.length - 1] * 5 + 5]], revision: 1, captures: [], conflicts: [] })

  // An event archive: `races` is { [RaceID]: [ids, tag?, count?] }.
  const eventFile = (races) => ({ version: events.EVENT_ARCHIVE_VERSION, races: Object.fromEntries(Object.entries(races).map(([RaceID, spec]) => [RaceID, eventRecord(...spec)])) })

  const eventOf = (inst, branchId = 'b1') => clone(inst.files.get(`file:campaign-c1-${branchId}-events`))

  const eventIds = (file, RaceID = 1) => (file && file.races && file.races[RaceID] ? file.races[RaceID].increments.map((increment) => increment[0]) : [])

  const eventWrites = (inst) => inst.writes.filter((name) => name.endsWith('-events'))

  // A backup as one made before event archives were recorded in it (version 1 or 2): no `eventCoverage`, no `events`, the digest sealed again.
  const beforeEvents = (envelope, version) => {
    const doc = JSON.parse(textOf(envelope))

    doc.version = version
    doc.campaigns.forEach((item) => {
      delete item.eventCoverage
      delete item.events

      if (version < backup.COLONY_COVERAGE_VERSION) {
        delete item.colonyCoverage
      }
    })
    doc.digest = campaign.hashValue(doc.campaigns)

    return parsed(doc)
  }

  // The stored installation holds archives on both branches, and the other one archives that differ from them on race 1 and add race 3.
  const withEvents = (stored, other) => {
    stored.put('file:campaign-c1-b1-events', eventFile({ 1: [[1, 2, 3]], 2: [[4]] }))
    stored.put('file:campaign-c1-b2-events', eventFile({ 1: [[1]] }))
    other.put('file:campaign-c1-b1-events', eventFile({ 1: [[2, 5], 'other'], 3: [[7]] }))
    other.put('file:campaign-c1-b2-events', eventFile({ 1: [[9]] }))
  }

  check('events', 'the event archive of each branch goes into the backup beside its history and comes back exactly in an empty installation, each branch apart from the others; an installation without archives gives a backup with none', async () => {
    const { stored, other } = pair()

    stored.put('file:campaign-c1-b1-events', eventFile({ 1: [[1, 2, 3]], 2: [[4]] }))
    stored.put('file:campaign-c1-b2-events', eventFile({ 1: [[1]] }))

    const bare = parsed(exportOf(other)).campaigns[0]

    assert.equal(bare.events, undefined)
    assert.equal(bare.eventCoverage, true, 'a backup says it records the event archives, so that none is a known state')
    assert.deepEqual(Object.keys(bare).sort(), ['annotations', 'branches', 'colonyCoverage', 'entry', 'eventCoverage', 'id'], 'nothing but the statement is added to a campaign without archives')

    const envelope = parsed(exportOf(stored))

    assert.deepEqual(Object.keys(envelope.campaigns[0].events).sort(), ['b1', 'b2'])
    assert.deepEqual(envelope.campaigns[0].events.b1, eventOf(stored, 'b1'))

    const empty = installation({ first: 3 })
    const row = plan(empty, envelope).preview.campaigns[0].files[0].events

    assert.equal(row.status, 'new')
    assert.equal(row.kind, 'events')
    assert.equal(row.totals.added, 4)

    await restore(empty, envelope)

    assert.deepEqual(eventOf(empty, 'b1'), eventOf(stored, 'b1'))
    assert.deepEqual(eventOf(empty, 'b2'), eventOf(stored, 'b2'))
    assert.deepEqual(eventIds(eventOf(empty, 'b2')), [1], 'the second branch has its own archive, not the first\'s')
    assert.equal(plan(empty, envelope).preview.nothingToDo, true)

    // an archive cleared of every race is still an archive, and comes back as one
    const cleared = pair()

    cleared.stored.put('file:campaign-c1-b1-events', { version: events.EVENT_ARCHIVE_VERSION, races: {} })

    const kept = parsed(exportOf(cleared.stored))
    const again = installation({ first: 4 })

    assert.deepEqual(kept.campaigns[0].events, { b1: { version: events.EVENT_ARCHIVE_VERSION, races: {} } })

    await restore(again, kept)

    assert.deepEqual(eventOf(again, 'b1'), { version: events.EVENT_ARCHIVE_VERSION, races: {} })
  })

  check('events', 'a backup made before event archives were recorded in it (version 1 or 2) restores over stored archives without touching them, under every policy, and its preview shows no event row', async () => {
    for (const version of [1, 2]) {
      const { stored, other } = pair()

      withEvents(stored, other)

      const before = [eventOf(stored, 'b1'), eventOf(stored, 'b2')]
      const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' }, b2: { policy: 'merge' } } } } }
      const old = beforeEvents(exportOf(other), version)

      assert.equal(old.version, version)
      assert.ok(plan(stored, old, choices).preview.campaigns[0].files.every((row) => row.events === undefined))

      const { result } = await restore(stored, old, choices)

      assert.equal(result.applied, true)
      assert.deepEqual(timesOf(stored.fileOf('c1', 'b1')), [200, 300, 400, 500], 'the history was restored')
      assert.deepEqual([eventOf(stored, 'b1'), eventOf(stored, 'b2')], before)
      assert.deepEqual(eventWrites(stored), [])
    }
  })

  check('events', 'the event archives of a branch are merged, replaced or kept by the policy of its history file and the races chosen: a merge adds the races the stored archive lacks and keeps the others, a replace gives the branch exactly the archive of the backup', async () => {
    const { stored, other } = pair()

    withEvents(stored, other)

    const choices = { campaigns: { c1: { files: { b1: { policy: 'merge' }, b2: { policy: 'replace' } } } } }
    const planned = plan(stored, parsed(exportOf(other)), choices)
    const [b1, b2] = planned.preview.campaigns[0].files.map((file) => file.events)

    assert.equal(b1.policy, 'merge')
    assert.equal(b1.totals.stored, 4)
    assert.equal(b1.totals.backup, 3)
    assert.equal(b1.totals.added, 1, 'race 3 is not stored')
    assert.equal(b1.totals.conflicts, 2, 'the backup\'s race 1 differs from the stored one, which stays')
    assert.equal(b1.totals.removed, 0)
    assert.equal(b1.status, 'changes')
    assert.ok(b1.series.every((row) => row.label.startsWith('events of race')))
    assert.equal(b2.policy, 'replace')
    assert.equal(b2.totals.conflicts, 1, 'the stored record of race 1 is overwritten')
    assert.equal(planned.preview.totals.events, 1)
    assert.equal(planned.preview.totals.eventsRemoved, 1)
    assert.ok(planned.preview.needsConfirmation.some((message) => /event archive/.test(message)), 'a replace asks to confirm the events it drops or overwrites')

    const before = stored.snapshot()

    await rejects(() => restore(stored, parsed(exportOf(other)), choices, { confirmed: false }), 'Rejected')

    assert.equal(stored.snapshot(), before, 'nothing is written without the confirmation')

    await restore(stored, parsed(exportOf(other)), choices)

    assert.deepEqual(Object.keys(eventOf(stored, 'b1').races).sort(), ['1', '2', '3'], 'a merge never removes a race')
    assert.deepEqual(eventIds(eventOf(stored, 'b1')), [1, 2, 3], 'the stored record of race 1 stays')
    assert.deepEqual(eventIds(eventOf(stored, 'b1'), 3), [7])
    assert.deepEqual(eventOf(stored, 'b2'), eventOf(other, 'b2'), 'a replace takes the backup\'s archive')

    // a replace of a backup that records its archives drops a stored race it lacks, and a keep leaves the file as it is
    const second = pair()

    withEvents(second.stored, second.other)

    const replaced = { campaigns: { c1: { files: { b1: { policy: 'replace' }, b2: { policy: 'keep' } } } } }
    const b2Before = eventOf(second.stored, 'b2')
    const shown = plan(second.stored, parsed(exportOf(second.other)), replaced)

    assert.equal(shown.preview.campaigns[0].files[0].events.totals.removed, 1)
    assert.equal(shown.preview.campaigns[0].files[1].events.status, 'kept')

    await restore(second.stored, parsed(exportOf(second.other)), replaced)

    assert.deepEqual(eventOf(second.stored, 'b1'), eventOf(second.other, 'b1'), 'exactly the archive of the backup')
    assert.deepEqual(eventOf(second.stored, 'b2'), b2Before)
    assert.deepEqual(eventWrites(second.stored), ['file:campaign-c1-b1-events'])

    // the races chosen are the only ones a policy touches
    const third = pair()

    withEvents(third.stored, third.other)

    const b1Before = eventOf(third.stored, 'b1')

    await restore(third.stored, parsed(exportOf(third.other)), { campaigns: { c1: { files: { b1: { policy: 'merge', races: ['1'] }, b2: { policy: 'keep' } } } } })

    assert.deepEqual(eventOf(third.stored, 'b1'), b1Before, 'race 1 was chosen, and a merge keeps its stored record; race 3 was not chosen')

    await restore(third.stored, parsed(exportOf(third.other)), { campaigns: { c1: { files: { b1: { policy: 'replace', races: ['2'] }, b2: { policy: 'keep' } } } } })

    assert.deepEqual(Object.keys(eventOf(third.stored, 'b1').races), ['1'], 'race 2 was chosen and the backup lacks it')
    assert.deepEqual(eventOf(third.stored, 'b1').races[1], b1Before.races[1], 'race 1 was not chosen')
  })

  check('events', 'a branch whose timeline is not the stored one keeps its event archive, shown as kept with the reason, and a stored archive this version cannot read is shown as kept and stops the restore', async () => {
    const stored = installation()
    const other = installation({ first: 2 })

    seed(stored, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(150) } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }), 'c1-b1-events': eventFile({ 1: [[1, 2]] }) } })
    seed(other, { entries: [entryOf({ id: 'c1', branches: { b1: tipOf(150, 7) } })], files: { 'c1-b1': fileOf({ races: { 1: { times: [200] } } }), 'c1-b1-events': eventFile({ 1: [[5]] }) } })

    const before = stored.snapshot()
    const [row] = plan(stored, parsed(exportOf(other)), { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } }).preview.campaigns[0].files

    assert.match(row.events.locked, /different timeline/)
    assert.equal(row.events.policy, 'keep')
    assert.equal(row.events.status, 'kept')

    await restore(stored, parsed(exportOf(other)))

    assert.equal(stored.snapshot(), before)

    // a stored archive this version cannot read is shown as kept with the reason, and the restore is refused whole, because a safety copy that covers the archives cannot be made of it
    const damaged = pair()

    withEvents(damaged.stored, damaged.other)
    damaged.stored.put('file:campaign-c1-b1-events', { version: events.EVENT_ARCHIVE_VERSION, races: 5 })

    const [shown] = plan(damaged.stored, parsed(exportOf(damaged.other))).preview.campaigns[0].files

    assert.match(shown.events.locked, /not one this version reads/)
    assert.equal(shown.events.status, 'kept')

    const damagedBefore = damaged.stored.snapshot()
    const stopped = await rejects(() => restore(damaged.stored, parsed(exportOf(damaged.other))), 'Rejected')

    assert.match(stopped.message, /event archive of branch b1 of campaign c1 cannot be read/)
    assert.equal(damaged.stored.snapshot(), damagedBefore, 'nothing was written, and the damaged file is as it was')
  })

  check('events', 'a backup whose event archives are malformed is refused whatever its digest: a branch the campaign lacks, an empty file, another version, a key not read, a bad race id, increments out of order, a bad group, a bad span, a bad capture record, and a statement of coverage that is not true or not allowed', async () => {
    const evented = (change) => {
      const { stored } = pair()

      stored.put('file:campaign-c1-b1-events', eventFile({ 1: [[1, 2]], 2: [[4]] }))

      const doc = JSON.parse(textOf(exportOf(stored)))

      change(doc.campaigns[0].events, doc)

      return sealed(JSON.stringify(doc))
    }

    refused(evented((archives) => { archives.b9 = archives.b1 }), /not a map of the branches/)
    refused(evented((_archives, doc) => { doc.campaigns[0].events = {} }), /not a map of the branches/)
    refused(evented((archives) => { archives.b1 = {} }), /is not an event archive/)
    refused(evented((archives) => { archives.b1 = 'text' }), /is not an event archive/)
    refused(evented((archives) => { archives.b1.version = 2 }), /not an event archive this version reads/)
    refused(evented((archives) => { archives.b1.extra = 1 }), /not an event archive this version reads/)
    refused(evented((archives) => { archives.b1.races.x = archives.b1.races[1] }), /race x is not a record/)
    refused(evented((archives) => { archives.b1.races[1].increments.reverse() }), /increments out of order/)
    refused(evented((archives) => { archives.b1.races[1].increments[0][3][0][9] = 0 }), /increment this version cannot read/)
    refused(evented((archives) => { archives.b1.races[1].increments[0][3] = [] }), /increment this version cannot read/)
    refused(evented((archives) => { archives.b1.races[1].spans = [[5, 1]] }), /span this version cannot read/)
    refused(evented((archives) => { archives.b1.races[1].revision = -1 }), /capture record this version cannot read/)
    refused(evented((archives) => { archives.b1.races[1].increments[0][3][0][9] = 1e9 }), /holds more events than any cap allows/)
    refused(evented((archives) => { archives.b1.races[1].increments[0][3][0][9] = events.MAX_EVENTS }), /holds more events than any cap allows/)
    assert.equal(backup.parseBackup(evented((archives) => { archives.b1.races[1].increments[0][3][0][9] = events.MAX_EVENTS - 1 })).errors, undefined, 'exactly the most a cap allows is read')
    refused(evented((_archives, doc) => { doc.campaigns[0].eventCoverage = false }), /event coverage is not true/)
    refused(evented((_archives, doc) => { delete doc.campaigns[0].eventCoverage }), /event coverage is not true/)
    refused(evented((_archives, doc) => { doc.version = 2 }), /holds eventCoverage or events, which a version 2 backup does not state/)
    refused(evented((_archives, doc) => { doc.version = 2; delete doc.campaigns[0].eventCoverage }), /holds eventCoverage or events, which a version 2 backup does not state/)
    assert.equal(backup.parseBackup(evented(() => {})).errors, undefined)
  })

  check('events', 'a backup is of version 3 and says it covers the event archives; one of version 1 or 2 is read as before and never says so, and a version 3 backup without the statement is refused', async () => {
    const { stored } = pair()

    stored.put('file:campaign-c1-b1-events', eventFile({ 1: [[1]] }))

    const envelope = parsed(exportOf(stored))

    assert.equal(backup.VERSION, 3)
    assert.equal(backup.EVENT_COVERAGE_VERSION, 3)
    assert.equal(envelope.version, 3)
    assert.ok(envelope.campaigns.every((item) => item.eventCoverage === true))

    for (const version of [1, 2]) {
      const old = beforeEvents(envelope, version)

      assert.equal(old.version, version)
      assert.equal(old.campaigns[0].eventCoverage, undefined)
      assert.equal(old.campaigns[0].events, undefined)
    }

    const doc = JSON.parse(textOf(envelope))

    delete doc.campaigns[0].eventCoverage
    refused(sealed(JSON.stringify(doc)), /event coverage is not true/)
  })

  check('events', 'a stored event archive this version cannot read is never left out of a backup that says it covers the event archives: the export and the safety copy are refused naming the branch and nothing is written, while a store that is not there is covered as none', async () => {
    const readable = eventFile({ 1: [[1, 2]] })
    const broken = [{ ...readable, races: 5 }, { ...readable, version: 2 }, { ...readable, extra: 1 }, { races: readable.races }, { ...readable, races: { x: readable.races[1] } }, { ...readable, races: { 1: { ...readable.races[1], increments: 'none' } } }, 'text', 7]

    for (const file of broken) {
      const { stored, other } = pair()

      stored.put('file:campaign-c1-b1-events', readable)
      stored.put('file:campaign-c1-b2-events', file)

      const refusal = await rejects(async () => exportOf(stored), 'Rejected')

      assert.match(refusal.message, /event archive of branch b2 of campaign c1 cannot be read/, JSON.stringify(file))

      const before = stored.snapshot()
      const stopped = await rejects(() => restore(stored, parsed(exportOf(other))), 'Rejected')

      assert.match(stopped.message, /backup of the current history could not be made.*event archive of branch b2 of campaign c1 cannot be read/, JSON.stringify(file))
      assert.equal(stored.snapshot(), before, 'nothing was written')
    }

    const empty = pair().stored

    empty.put('file:campaign-c1-b1-events', {})

    const exported = parsed(exportOf(empty))

    assert.equal(exported.campaigns[0].eventCoverage, true)
    assert.equal(exported.campaigns[0].events, undefined, 'a store with nothing in it is no archive')
  })

  check('events', 'a preview of event archives writes nothing, counts them as files with the history\'s but not in the snapshot figures, and a restore writes exactly the files the preview counted', async () => {
    const { stored, other } = pair()

    withEvents(stored, other)

    const choices = { campaigns: { c1: { files: { b1: { policy: 'merge' }, b2: { policy: 'merge' } } } } }
    const before = stored.snapshot()
    const planned = plan(stored, parsed(exportOf(other)), choices)
    const rows = planned.preview.campaigns[0].files

    assert.equal(stored.snapshot(), before)
    assert.equal(planned.preview.totals.files, 3, 'two history files and the archive of branch b1 change; a merge keeps the stored race of branch b2 as it is')
    assert.equal(rows.reduce((sum, row) => sum + row.events.totals.conflicts, 0), 3, 'the events of race 1 of both branches differ')
    assert.equal(planned.preview.totals.conflicts, rows.reduce((sum, row) => sum + row.totals.conflicts, 0), 'the conflicts of the history files, not the events')
    assert.equal(planned.preview.totals.events, 1)

    const { result } = await restore(stored, parsed(exportOf(other)), choices)

    assert.equal(result.files, 3)
    assert.equal(eventWrites(stored).length, 1)
  })

  check('events', 'a restore of event archives is undone from its safety copy: the copy holds the archives as they were, and restoring it with Replace brings them back', async () => {
    const { stored, other } = pair()

    withEvents(stored, other)

    const original = eventOf(stored, 'b1')
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } }

    await restore(stored, parsed(exportOf(other)), choices)

    assert.deepEqual(Object.keys(eventOf(stored, 'b1').races).sort(), ['1', '3'])

    const [held] = backup.keptBackups(stored.io)

    assert.deepEqual(held.envelope.campaigns[0].events.b1, original)

    await restore(stored, parsed(held.envelope), choices)

    assert.deepEqual(eventOf(stored, 'b1'), original)
  })

  check('events', 'a safety copy taken before a restore that adds event archives restores them away again with Replace: from a branch with no archive the file is emptied, and nothing is shown or written where neither side holds archives; a Merge of the copy changes nothing', async () => {
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' } } } } }

    // no archive on either side: nothing to restore
    const bare = pair()
    const quiet = plan(bare.stored, parsed(exportOf(bare.other)), choices)

    assert.ok(quiet.preview.campaigns[0].files.every((row) => row.events === undefined))
    assert.equal(eventWrites(bare.stored).length, 0)

    // a branch with no archive takes a restore that adds one
    const { stored, other } = pair()

    other.put('file:campaign-c1-b1-events', eventFile({ 1: [[2, 5]], 3: [[7]] }))
    await restore(stored, parsed(exportOf(other)))

    assert.deepEqual(Object.keys(eventOf(stored, 'b1').races).sort(), ['1', '3'])

    const [held] = backup.keptBackups(stored.io)

    assert.equal(held.envelope.campaigns[0].eventCoverage, true)
    assert.equal(held.envelope.campaigns[0].events, undefined, 'the copy has no archive to hold')

    const planned = plan(stored, parsed(held.envelope), choices)

    assert.equal(planned.preview.nothingToDo, false)
    assert.equal(planned.preview.campaigns[0].files[0].events.totals.removed, 3)

    await restore(stored, parsed(held.envelope), choices)

    assert.deepEqual(eventOf(stored, 'b1'), { version: events.EVENT_ARCHIVE_VERSION, races: {} }, 'the archive is as it was, none: a readable archive with no race, which is the branch\'s own file')
    assert.equal(plan(stored, parsed(held.envelope), choices).preview.nothingToDo, true)

    // a Merge of the copy adds, it never removes
    const third = pair()

    third.other.put('file:campaign-c1-b1-events', eventFile({ 1: [[2]] }))
    await restore(third.stored, parsed(exportOf(third.other)))

    const [copy] = backup.keptBackups(third.stored.io)
    const kept = eventOf(third.stored, 'b1')

    await restore(third.stored, parsed(copy.envelope))

    assert.deepEqual(eventOf(third.stored, 'b1'), kept)
  })

  check('events', 'a covered Replace that restores the absence of an archive onto a fork that was never marked as seeded writes a readable empty archive, so the next capture does not take the parent\'s archive again, whether or not the branch is marked', async () => {
    const choices = { campaigns: { c1: { files: { b2: { policy: 'replace' } } } } }
    const emptyArchive = { version: events.EVENT_ARCHIVE_VERSION, races: {} }

    for (const marked of [false, true]) {
      const { stored, other } = pair()

      if (marked) {
        const registry = stored.registry()

        registry.campaigns.c1.branches.b2.eventsSeeded = true
        stored.put('registry', registry)
      }

      // the parent holds an archive up to the fork, and so does the fork itself; the backup's fork has none
      stored.put('file:campaign-c1-b1-events', eventFile({ 1: [[1, 2, 3]] }))
      stored.put('file:campaign-c1-b2-events', eventFile({ 1: [[1]], 2: [[2]] }))

      const fork = stored.registry().campaigns.c1

      assert.equal(fork.branches.b2.parent, 'b1')
      assert.equal(fork.branches.b2.eventsSeeded === true, marked)

      await restore(stored, parsed(exportOf(other)), choices)

      assert.deepEqual(eventOf(stored, 'b2'), emptyArchive, 'the fork keeps a file of its own, with no race')
      assert.deepEqual(eventIds(eventOf(stored, 'b1')), [1, 2, 3], 'the parent is not touched')
      assert.deepEqual(events.eventBase(stored.io, stored.registry().campaigns.c1, 'b2'), emptyArchive, 'the next capture starts from nothing, not from the parent')
      assert.deepEqual(events.eventSeed(stored.io, stored.registry().campaigns.c1, 'b2', 320), {}, 'and a branch below it is not given the parent\'s archive through it')

      // the safety copy still undoes the restore exactly
      const [held] = backup.keptBackups(stored.io)

      await restore(stored, parsed(held.envelope), choices)

      assert.deepEqual(eventOf(stored, 'b2'), eventFile({ 1: [[1]], 2: [[2]] }))
    }
  })

  check('events', 'a race record that carries failures (the captures whose read failed) comes back exactly in a backup and a restore, and a backup holds the failures as the file check reads them', async () => {
    const { stored } = pair()
    const file = eventFile({ 1: [[1, 2]] })

    file.races[1].failures = [{ at: 1700000000000, t: 25, reason: 'the log could not be read' }, { at: 1700000001000, t: 30, reason: 'locked' }]
    stored.put('file:campaign-c1-b1-events', file)

    const envelope = parsed(exportOf(stored))

    assert.deepEqual(envelope.campaigns[0].events.b1, file)

    const empty = installation({ first: 3 })

    await restore(empty, envelope)

    assert.deepEqual(eventOf(empty, 'b1'), file)
    assert.deepEqual(parsed(exportOf(empty)).campaigns[0].events.b1, file)

    // a record whose failures the file check does not read is not carried into a backup either way: the backup and the file check agree
    const bad = JSON.parse(JSON.stringify(file))

    bad.races[1].failures = 'none'

    const doc = JSON.parse(textOf(envelope))

    doc.campaigns[0].events.b1 = bad

    const out = backup.parseBackup(sealed(JSON.stringify(doc)))

    assert.equal(out.envelope === undefined, events.eventFileProblem(bad) !== null)
  })

  check('events', 'a Replace of a parent and its unmarked fork, neither holding an archive file yet, from a backup that holds the parent\'s events from before the fork and none for the fork, leaves the fork an empty archive: what it would inherit is read from the parent as the restore leaves it', async () => {
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' }, b2: { policy: 'replace' } } } } }
    const emptyArchive = { version: events.EVENT_ARCHIVE_VERSION, races: {} }
    const forkOf = (inst) => ({ ...inst.registry().campaigns.c1, id: 'c1' })
    const { stored, other } = pair()

    other.put('file:campaign-c1-b1-events', eventFile({ 1: [[1, 2, 3]] }))

    assert.equal(eventOf(stored, 'b1'), undefined)
    assert.equal(eventOf(stored, 'b2'), undefined)
    assert.equal(stored.registry().campaigns.c1.branches.b2.eventsSeeded, undefined)
    assert.deepEqual(events.eventBase(stored.io, forkOf(stored), 'b2'), {}, 'nothing to inherit before the restore')

    const envelope = parsed(exportOf(other))

    assert.equal(envelope.campaigns[0].events.b2, undefined)

    const shown = plan(stored, envelope, choices).preview.campaigns[0].files[1].events

    assert.ok(shown, 'the plan has an event row for the fork')
    assert.equal(shown.totals.removed, 3, 'the events the restore gives the parent are what the fork would inherit')

    await restore(stored, envelope, choices)

    assert.deepEqual(eventIds(eventOf(stored, 'b1')), [1, 2, 3], 'the parent has the backup\'s archive')
    assert.deepEqual(eventOf(stored, 'b2'), emptyArchive)
    assert.deepEqual(events.eventBase(stored.io, forkOf(stored), 'b2'), emptyArchive, 'the next capture of the fork starts from nothing')
    assert.equal(plan(stored, envelope, choices).preview.nothingToDo, true)
  })

  check('events', 'a lineage numbered in reverse (b1 forked from b2) restored with Replace on both branches, from a backup that holds the parent\'s events from before the fork, leaves the child, b1, an empty archive: archives are planned in ancestry order, not numeric order', async () => {
    const choices = { campaigns: { c1: { files: { b1: { policy: 'replace' }, b2: { policy: 'replace' } } } } }
    const emptyArchive = { version: events.EVENT_ARCHIVE_VERSION, races: {} }
    const source = installation({ first: 2 })
    const entry = entryOf({ id: 'c1', branches: { b1: tipOf(100), b2: tipOf(100) } })

    entry.branches.b1.parent = 'b2'
    entry.branches.b1.fork = { n: 64, digest: 'fork', t: 320 }
    entry.branches.b2.parent = null
    entry.branches.b2.fork = null
    seed(source, { entries: [entry], files: { 'c1-b1': fileOf({ races: { 1: { times: [100] } } }), 'c1-b2': fileOf({ races: { 1: { times: [100] } } }), 'c1-b2-events': eventFile({ 1: [[1, 2, 3]] }) } })

    const envelope = parsed(exportOf(source))
    const empty = installation({ first: 3 })
    const forkOf = (inst) => ({ ...inst.registry().campaigns.c1, id: 'c1' })
    const shown = plan(empty, envelope, choices).preview.campaigns[0].files

    assert.deepEqual(shown.map((row) => row.branchId), ['b1', 'b2'], 'the rows stay in numeric order')
    assert.equal(shown[0].events.totals.removed, 3, 'the child would inherit the parent\'s restored events, and the plan removes them')

    await restore(empty, envelope, choices)

    assert.deepEqual(eventIds(eventOf(empty, 'b2')), [1, 2, 3], 'the parent has the backup\'s archive')
    assert.deepEqual(eventOf(empty, 'b1'), emptyArchive, 'the child has an empty archive of its own')
    assert.deepEqual(events.eventBase(empty.io, forkOf(empty), 'b1'), emptyArchive, 'the next capture of the child starts from nothing')
    assert.equal(plan(empty, envelope, choices).preview.nothingToDo, true)
  })

  check('events', 'a covered Replace of an unmarked fork with no archive file of its own, whose parent holds events from before the fork, writes a readable empty archive, so the next capture does not inherit them; a fork that could inherit nothing, a Merge and a branch whose history is kept are not touched, and the races not chosen stay inherited as stored', async () => {
    const choices = { campaigns: { c1: { files: { b2: { policy: 'replace' } } } } }
    const emptyArchive = { version: events.EVENT_ARCHIVE_VERSION, races: {} }
    const forkOf = (inst) => ({ ...inst.registry().campaigns.c1, id: 'c1' })

    // the parent holds events from before the fork (the fork is at game time 320); the fork has no file of its own and is not marked
    const { stored, other } = pair()

    stored.put('file:campaign-c1-b1-events', eventFile({ 1: [[1, 2, 3]], 2: [[4]] }))

    assert.equal(stored.registry().campaigns.c1.branches.b2.eventsSeeded, undefined)
    assert.equal(eventOf(stored, 'b2'), undefined, 'the fork has no file of its own')
    assert.ok(Object.keys(events.eventBase(stored.io, forkOf(stored), 'b2').races).length > 0, 'it would inherit the parent\'s events')

    const envelope = parsed(exportOf(other))
    const planned = plan(stored, envelope, choices)
    const shown = planned.preview.campaigns[0].files[1].events

    assert.ok(shown, 'the plan has an event row for the fork')
    assert.equal(shown.totals.removed, 4, 'the inherited events are what the Replace drops')
    assert.ok(planned.preview.needsConfirmation.some((message) => /event archive/.test(message)))

    const before = eventOf(stored, 'b1')

    await restore(stored, envelope, choices)

    assert.deepEqual(eventOf(stored, 'b2'), emptyArchive)
    assert.deepEqual(eventOf(stored, 'b1'), before, 'the parent is not touched')
    assert.deepEqual(events.eventBase(stored.io, forkOf(stored), 'b2'), emptyArchive, 'the next capture starts from nothing')

    // a Merge and a kept history leave the fork as it was, inheriting
    for (const policy of ['merge', 'keep']) {
      const run = pair()

      run.stored.put('file:campaign-c1-b1-events', eventFile({ 1: [[1, 2, 3]] }))

      const pending = plan(run.stored, parsed(exportOf(run.other)), { campaigns: { c1: { files: { b2: { policy } } } } })

      assert.equal(pending.preview.campaigns[0].files[1].events, undefined, policy)
      assert.equal(pending.writes.files.some((write) => write.name.endsWith('-b2-events')), false, policy)
    }

    // a fork that could inherit nothing is not given a file: the parent's events all come after the fork
    const late = pair()

    late.stored.put('file:campaign-c1-b1-events', eventFile({ 1: [[70, 71]] }))

    const quiet = plan(late.stored, parsed(exportOf(late.other)), choices)

    assert.equal(quiet.preview.campaigns[0].files[1].events, undefined)
    assert.equal(quiet.writes.files.some((write) => write.name.endsWith('-b2-events')), false)

    // a fork already marked as seeded inherits nothing, so it is left with no file too
    const marked = pair()
    const registry = marked.stored.registry()

    registry.campaigns.c1.branches.b2.eventsSeeded = true
    marked.stored.put('registry', registry)
    marked.stored.put('file:campaign-c1-b1-events', eventFile({ 1: [[1, 2, 3]] }))
    assert.equal(plan(marked.stored, parsed(exportOf(marked.other)), choices).preview.campaigns[0].files[1].events, undefined)

    // the races not chosen stay as the fork inherits them: they are written into its own file
    const partial = pair()

    partial.stored.put('file:campaign-c1-b1-events', eventFile({ 1: [[1, 2]], 2: [[3]] }))
    await restore(partial.stored, parsed(exportOf(partial.other)), { campaigns: { c1: { files: { b2: { policy: 'replace', races: ['2'] } } } } })

    assert.deepEqual(Object.keys(eventOf(partial.stored, 'b2').races), ['1'])
    assert.deepEqual(eventOf(partial.stored, 'b2').races[1], eventOf(partial.stored, 'b1').races[1])
  })

  return checks
}

// ---- Real saves -------------------------------------------------------------------------------------------------------

const PASSIVE = path.join(repo, 'artifacts', 'passive-campaign-20261013')

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// The saves of the passive campaign picked by index, opened read only: `record(installation, rows)` records them in order with the recorder, `checksums()` is the sha256 of each file now and `expected` what the run recorded for it; null when the folder is not here.
const realSaves = async (m, picks) => {
  if (!fs.existsSync(path.join(PASSIVE, 'snapshots.csv'))) {
    console.log('  skip   the passive campaign is not here')

    return null
  }

  const sqlite3 = require('sqlite3')
  const rows = fs.readFileSync(path.join(PASSIVE, 'snapshots.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map((line) => {
    const [index, , file, hash] = line.split(',')

    return { index: Number(index), file, sha256: hash }
  })
  const chosen = picks.map((index) => rows.find((row) => row.index === index))

  assert.ok(chosen.every((row) => row && fs.existsSync(path.join(PASSIVE, 'snapshots', row.file))), 'a save of the passive campaign is missing')

  const handles = new Map()

  for (const row of chosen) {
    handles.set(row.file, await new Promise((resolve, reject) => {
      const handle = new sqlite3.Database(path.join(PASSIVE, 'snapshots', row.file), sqlite3.OPEN_READONLY, (error) => (error ? reject(error) : resolve(handle)))
    }))
  }

  const database = (row) => ({
    transaction: (work) => work({ id: 'transaction' }),
    query: (sql) => new Promise((resolve, reject) => handles.get(row.file).all(sql, (error, result) => (error ? reject(error) : resolve([result])))),
  })

  return {
    picks: chosen,
    expected: Object.fromEntries(chosen.map((row) => [row.file, row.sha256])),
    checksums: async () => Object.fromEntries(chosen.map((row) => [row.file, sha256(path.join(PASSIVE, 'snapshots', row.file))])),
    record: async (inst, list) => {
      for (const row of list) {
        const run = await m.history.recordHistory(database(row), { storage: inst.io, path: `C:/saves/${row.file}`, now: inst.now, newId: inst.newId })

        assert.equal(run.failed.length, 0, run.failed.map((failure) => failure.error && failure.error.message).join('; '))
      }
    },
    close: () => handles.forEach((handle) => handle.close()),
  }
}

// ---- Running ----------------------------------------------------------------------------------------------------------

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
  { name: 'the digest of the backup is not compared', find: 'if (envelope.digest !== hashValue(envelope.campaigns)) {', replace: 'if (false) {', fails: ['a backup that was altered'] },
  { name: 'a backup of a newer version is read', find: 'if (envelope.version > VERSION) {', replace: 'if (false) {', fails: ['a file of a future schema'] },
  { name: 'newer campaign records are read', find: 'if (envelope.schemas.registry > REGISTRY_VERSION) {', replace: 'if (false) {', fails: ['a file of a future schema'] },
  { name: 'newer annotations are read', find: 'if (bundle.version > BUNDLE_VERSION) {', replace: 'if (false) {', fails: ['a file of a future schema'] },
  { name: 'a game time that is not finite is accepted', find: 'const isNumber = (value) => typeof value === \'number\' && Number.isFinite(value)', replace: 'const isNumber = (value) => typeof value === \'number\'', fails: ['a game time that is not finite'] },
  { name: 'a game time that does not increase is accepted', find: 'if (index > 0 && !(snapshot.t > series.snapshots[index - 1].t)) {', replace: 'if (false) {', fails: ['a game time that is not finite'] },
  { name: 'the units of the race figures are not compared', find: 'sameUnits(envelope.units.race, UNITS, \'The units of a race\\\'s figures\')', replace: '', fails: ['a figure with units'] },
  { name: 'the units of the intelligence figures are not compared', find: 'sameUnits(envelope.units.intelligence, INTEL_UNITS, \'The units of what a race knows of another\')', replace: '', fails: ['a figure with units'] },
  { name: 'a malformed chain on a snapshot is accepted', find: 'if (!isChain(value) || Object.keys(value).length !== 2) {', replace: 'if (false) {', fails: ['a snapshot may carry the chain'] },
  { name: 'a chain is accepted on an intelligence snapshot', find: 'if (field === \'chain\' && race) {', replace: 'if (field === \'chain\') {', fails: ['a snapshot may carry the chain'] },
  { name: 'the coverage of a series is not compared', find: 'if (!isObject(series.coverage) || series.coverage.count !== count || series.coverage.first !== first || series.coverage.last !== last || Object.keys(series.coverage).length !== 3) {', replace: 'if (false) {', fails: ['a series whose coverage'] },
  { name: 'the size of a file is checked after it is parsed', find: 'if (!fitsLimit(body)) {', replace: 'if (false) {', fails: ['a file larger than the limit'] },
  { name: 'a campaign id may name a path', find: 'const ID = /^[A-Za-z0-9_-]+$/', replace: 'const ID = /^.+$/', fails: ['an id that could name'] },
  { name: 'a race id need not be canonical', find: 'const NUMERIC = /^(0|[1-9]\\d*)$/', replace: 'const NUMERIC = /^[0-9.]+$/', fails: ['an id that could name'] },
  { name: 'a branch id may be anything', find: 'const BRANCH = /^b[1-9]\\d*$/', replace: 'const BRANCH = /^.+$/', fails: ['an id that could name'] },
  { name: 'the backup wins at a shared game time under merge', find: 'const united = [...stored, ...given.filter((snapshot) => !known.has(snapshot.t))].sort(', replace: 'const united = [...stored.filter((snapshot) => !offered.has(snapshot.t)), ...given].sort(', fails: ['a merge keeps the stored snapshot', 'a stored snapshot at a shared game time'] },
  { name: 'what passes the cap is not thinned', find: 'const outcome = thinCounted(united)', replace: 'const outcome = { snapshots: united, passes: 0, dropped: 0, cap: MAX_SNAPSHOTS }', fails: ['a merge keeps the stored snapshot'] },
  { name: 'a kept target is written', find: 'if (row.policy !== \'keep\' && canonical(planned.file)', replace: 'if (canonical(planned.file)', fails: ['each target takes its own policy'] },
  { name: 'a replace does not count what it removes', find: 'stats.removed = stored.filter((snapshot) => !offered.has(snapshot.t)).length', replace: 'stats.removed = 0', fails: ['a replace that removes', 'replace makes the selected'] },
  { name: 'a restore that asks for a confirmation is applied without it', find: 'if (preview.needsConfirmation.length && !confirmed) {', replace: 'if (false) {', fails: ['a replace that removes', 'a campaign of another id that shares'] },
  { name: 'a campaign that shares a game id with another is not told apart', find: 'status = alike.length ? \'ambiguous\' : \'new\'', replace: 'status = \'new\'', fails: ['a campaign of another id that shares'] },
  { name: 'an ambiguous campaign is added without a confirmation', find: 'if (campaign.status === \'ambiguous\' && !campaign.skipped) {', replace: 'if (false) {', fails: ['a campaign of another id that shares'] },
  { name: 'a campaign of a different galaxy is restored', find: 'status = anchorRelation(stored.anchor, given.entry.anchor) === \'conflict\' ? \'conflict\' : \'known\'', replace: 'status = \'known\'', fails: ['a campaign of the same id with a different galaxy'] },
  { name: 'a stored answer is overwritten by the backup\'s', find: '} else if (own.answer !== attachment.answer || own.branchId !== attachment.branchId) {', replace: '} else if (own.answer !== attachment.answer || own.branchId !== attachment.branchId) {\n      own.answer = attachment.answer\n      own.pending = clone(attachment.pending)', fails: ['a stored answer, merge mark'] },
  { name: 'a tip behind or beside the stored one advances it', find: 'return longer === given ? \'extends\' : \'behind\'', replace: 'return \'extends\'', fails: ['a tip further along', 'one tip continues another only'] },
  { name: 'a different timeline moves the stored tip', find: 'if (relation === \'different\' || relation === \'unknown\') {\n      kept.push(', replace: 'if (false) {\n      kept.push(', fails: ['a branch whose timeline'] },
  { name: 'a different timeline overwrites the stored file', find: ': relations[branchId] === \'different\' ? \'the backup holds a different timeline for this branch\' : relations[branchId] === \'unknown\' ? \'too little is recorded to tell whether the backup is the same timeline\' : null', replace: ': null', fails: ['a branch whose timeline'] },
  { name: 'the metadata always comes from the backup', find: 'const newer = !kept || policy === \'replace\' || lastTime(snapshotsOf(entry.record)) > lastTime(before)', replace: 'const newer = true', fails: ['newer metadata is kept'] },
  { name: 'the backup wins a tie of the last game time', find: '|| lastTime(snapshotsOf(entry.record)) > lastTime(before)', replace: '|| lastTime(snapshotsOf(entry.record)) >= lastTime(before)', fails: ['newer metadata is kept'] },
  { name: 'the last time a campaign was seen moves back', find: 'merged.seen = Math.max(merged.seen, given.seen)', replace: 'merged.seen = given.seen', fails: ['newer metadata is kept'] },
  { name: 'a view without a series is dropped from a restored file', find: 'givenViews.filter((view) => result.intel[view] === undefined && selected(view))', replace: '[]', fails: ['a real recorded campaign comes back exactly'] },
  { name: 'a tab that does not record applies', find: '  requireRecording()\n\n  const key = restoreKey', replace: '  const key = restoreKey', fails: ['a tab that does not record'] },
  { name: 'a plan that changed since the preview is applied', find: 'if (digest !== expected) {', replace: 'if (false) {', fails: ['a plan that is no longer', 'a preview is bound'] },
  { name: 'no backup is kept before a restore', find: 'held = pinBackup(io, { ids: writes.affected, at: now(), key, annotations })', replace: 'held = null', fails: ['a backup of the affected campaigns', 'a backup that cannot be kept', 'a pre-restore backup restores'] },
  { name: 'a backup that was not kept does not stop the restore', find: 'if (!kept || kept.at !== entry.at || read.errors || read.envelope.digest !== envelope.digest) {', replace: 'if (false) {', fails: ['a backup that cannot be kept'] },
  { name: 'every backup is kept', find: '.slice(0, KEPT_BACKUPS)', replace: '.slice(0)', fails: ['only the newest few'] },
  { name: 'the registry is written without its compare-and-swap', find: '    writeRegistry(io, writes.registry)', replace: '    io.registry.store = writes.registry', fails: ['the registry is written last'] },
  { name: 'a restore with nothing to do still writes', find: 'if (preview.nothingToDo) {', replace: 'if (false) {', fails: ['a restore that stopped part way'] },
  { name: 'a record the file holds is counted as one to add', find: 'const taken = whole.items.filter((item) => item.status === \'import\').length', replace: 'const taken = whole.items.filter((item) => item.status !== \'rejected\').length', fails: ['a record is restored once'] },
  { name: 'annotations are restored by the import of a copy, not by the restore policy', find: 'const whole = annotations.preview(bundle, target, { restore: true })', replace: 'const whole = annotations.preview(bundle, target, { keepUuids: true })', fails: ['a record is restored once', 'a backup that holds an annotation twice'] },
  { name: 'the coverage of a series is not recorded', find: 'coverage: seriesCoverage(Array.isArray(series.snapshots) ? series.snapshots : [])', replace: 'coverage: { count: 0, first: null, last: null }', fails: ['a campaign with branches'] },
  { name: 'a shared checkpoint proves a continuation', find: 'const proof = shorter.n === 0 ? shorter.digest : digestAt(longer, shorter.n)', replace: 'const proof = shorter.digest', fails: ['one tip continues another only'] },
  { name: 'a tip no digest covers is taken for a continuation', find: 'if (proof === undefined) {\n    return \'unknown\'\n  }', replace: 'if (proof === undefined) {\n    return longer === given ? \'extends\' : \'behind\'\n  }', fails: ['one tip continues another only'] },
  { name: 'a retry makes a new backup of the history the failed attempt left', find: 'const held = unfinishedRestore(io)\n\n  if (held) {\n    requireContinuation', replace: 'const held = null\n\n  if (held) {\n    requireContinuation', fails: ['a restore that keeps failing', 'a restore that is not the unfinished one'] },
  { name: 'the backup of an unfinished restore is filed at once and aged out by later ones', find: 'io.backup.store = { version: 1, entries: keptBackups(io), unfinished: entry }', replace: 'io.backup.store = { version: 1, entries: [{ at: entry.at, label: entry.label, envelope: entry.envelope }, ...keptBackups(io)].slice(0, KEPT_BACKUPS) }', fails: ['a restore that keeps failing'] },
  { name: 'a finished restore does not file its backup', find: 'backup: held ? fileAway(io, held) : null', replace: 'backup: null', fails: ['a restore that keeps failing', 'a backup of the affected campaigns'] },
  { name: 'a restore that is not the unfinished one is applied over its pin', find: 'if (held.key !== key) {', replace: 'if (false) {', fails: ['a restore that is not the unfinished one'] },
  { name: 'a restore with nothing to do files the backup of another restore', find: 'if (!finished || finished.key !== key) {', replace: 'if (!finished) {', fails: ['a restore that is not the unfinished one', 'a restore carried out whose backup'] },
  { name: 'a restore with nothing left to do leaves its backup unfinished', find: 'return { applied: false, files: 0, imports: 0, registry: false, backup: fileAway(io, finished) }', replace: 'return { applied: false, files: 0, imports: 0, registry: false, backup: null }', fails: ['a restore carried out whose backup'] },
  { name: 'a damaged copy kept for an unfinished restore is reused', find: 'if (problem) {\n    throw new Rejected(', replace: 'if (false) {\n    throw new Rejected(', fails: ['a damaged copy kept'] },
  { name: 'an unfinished record that fails an outer check counts as none and is replaced', find: 'if (unfinished === undefined || unfinished === null) {', replace: 'if (!isObject(unfinished) || !isObject(unfinished.envelope) || unfinished.envelope.format !== \'aurora-electrons-history\') {', fails: ['a stored unfinished restore counts'] },
  { name: 'a record without an identity is named by its time and label, not by what is stored', find: 'hashValue([\'unnamed\', unfinished])', replace: 'hashValue([\'unnamed\', at, label])', fails: ['a record that holds no identity of its own'] },
  { name: 'a restore that reaches no stored campaign is applied over the pin of another restore', find: '  if (pinned) {\n    requireContinuation(pinned, key)\n  }', replace: '  if (pinned && writes.affected.length) {\n    requireContinuation(pinned, key)\n  }', fails: ['a backup that holds only campaigns not yet stored'] },
  { name: 'a retry that reaches no stored campaign does not file the pin it finishes', find: 'let held = pinned', replace: 'let held = null', fails: ['a retry whose remaining writes'] },
  { name: 'a damaged copy is reused by a retry that reaches no stored campaign', find: '} else if (pinned) {\n    requireReadable(pinned)\n  }', replace: '}', fails: ['a retry whose remaining writes'] },
  { name: 'a kept copy is named by what is inside it', find: 'const kept = new Date(isNumber(entry && entry.at) ? entry.at : NaN)', replace: 'const kept = new Date(entry.envelope.exportedAt)', fails: ['a kept copy is named by the time'] },
  { name: 'an annotation uuid of one campaign counts against every campaign', find: 'const key = [campaign.id, record.uuid].join(\'/\')', replace: 'const key = record.uuid', fails: ['two campaigns may hold one annotation uuid'] },
  { name: 'any pin is abandoned, not the one shown', find: 'if (held.id !== expectedId) {', replace: 'if (false) {', fails: ['an unfinished restore is abandoned by the identity shown'] },
  { name: 'a backup is kept whatever its size', find: 'if (!fitsLimit(JSON.stringify(envelope))) {', replace: 'if (false) {', fails: ['a history too large'] },
  { name: 'the size of a backup is counted in characters', find: 'const fitsLimit = (body) => body.length <= MAX_BYTES && (body.length * 3 <= MAX_BYTES || utf8Size(body) <= MAX_BYTES)', replace: 'const fitsLimit = (body) => body.length <= MAX_BYTES', fails: ['the size a backup may have'] },
  { name: 'a preview is not bound to the stored files and the counts it showed', find: 'const digest = hashValue({ files, registry: registryChanges, imports: imports.map((work) => [work.campaignId, work.target, work.preview.digest]), preview: campaigns, confirmations })', replace: 'const digest = hashValue({ files: files.map(({ name, value }) => ({ name, value })), registry: registryChanges, imports: imports.map((work) => [work.campaignId, work.target, work.preview.digest]) })', fails: ['a preview is bound'] },
  { name: 'the plan is not made again after the wait for the annotation files', find: 'if (planRestore({ io, envelope, choices, annotations }).digest !== expected) {', replace: 'if (false) {', fails: ['a history that changes while the annotation files are waited for'] },
  { name: 'an annotation may be in a backup twice', find: 'if (uuids.has(key)) {', replace: 'if (false) {', fails: ['a backup that holds an annotation twice'] },
  { name: 'an annotation of another campaign, race or branch is accepted', find: 'if (record.campaignId !== campaignId || record.RaceID !== bundle.source.RaceID || !isObject(record.association) || record.association.branchId !== bundle.source.branchId) {', replace: 'if (false) {', fails: ['an annotation whose campaign'] },
  { name: 'a unit map need not be complete', find: 'Object.keys(known).forEach((field) => {', replace: 'Object.keys({}).forEach((field) => {', fails: ['a backup whose unit maps'] },
  { name: 'a replace visits only the series the backup offers', find: 'if (policy === \'replace\') {\n    own.forEach((entry, key) => {', replace: 'if (false) {\n    own.forEach((entry, key) => {', fails: ['replace also removes'] },
  { name: 'a replace leaves the empty view of an owner the backup lacks', find: 'Object.keys(result.intel).filter((view) => selected(view) && !givenViews.includes(view))', replace: '[]', fails: ['replace also removes'] },
  { name: 'a deleted record is brought back as a copy', file: 'src/renderer/utilities/scenario-records.js', find: 'restore && (collides || tombstoned) ? \'skipped\' : \'import\'', replace: 'restore && collides ? \'skipped\' : \'import\'', fails: ['a record is restored once'] },
  { name: 'a stored record is imported again as a copy', file: 'src/renderer/utilities/scenario-records.js', find: 'restore && (collides || tombstoned) ? \'skipped\' : \'import\'', replace: 'restore && tombstoned ? \'skipped\' : \'import\'', fails: ['a record is restored once'] },
  { name: 'what a record needs to be skipped is decided before the import', file: 'src/renderer/utilities/scenario-records.js', find: 'const plan = planImport(file, b, t, keepUuids, restore)\n        const stamp', replace: 'const plan = planImport({ records: {}, tombstones: {} }, b, t, keepUuids, restore)\n        const stamp', fails: ['a backup that holds an annotation twice'] },
  { name: 'the colony series of a backup are not checked', find: 'Object.entries(campaign.colonies).forEach(([branchId, file]) => checkColonyFile(', replace: 'Object.entries({}).forEach(([branchId, file]) => checkColonyFile(', fails: ['a backup whose colony series are malformed'] },
  { name: 'the columns of a colony file are not compared', find: 'if (canonical(file.columns) !== canonical(COLONY_COLUMNS)) {', replace: 'if (false) {', fails: ['a backup whose colony series are malformed'] },
  { name: 'colony snapshots may be out of time order', find: 'if (index > 0 && !(snapshot.t > colonyBefore(series, index))) {', replace: 'if (false) {', fails: ['a backup whose colony series are malformed'] },
  { name: 'a campaign may not hold colony series', find: '\'annotations\', \'colonies\', \'colonyCoverage\', \'events\', \'eventCoverage\'], where)', replace: '\'annotations\', \'colonyCoverage\', \'events\', \'eventCoverage\'], where)', fails: ['the colony series of each branch go into'] },
  { name: 'a backup leaves the colony series out', find: '...(Object.keys(colonies).length ? { colonies } : {})', replace: '...({})', fails: ['the colony series of each branch go into', 'the colony series of a branch are merged', 'a restore of colony series is undone'] },
  { name: 'the colony files of a restore are not written', find: 'writes.files.push(colonies.write)', replace: 'void colonies.write', fails: ['the colony series of each branch go into', 'a preview of colony series writes nothing', 'the colony series of a branch are merged'] },
  { name: 'a replace of a backup without coverage drops the colony series it lacks', find: '{ ...(isObject(stored.races) ? stored.races : {}), ...present }', replace: 'present', fails: ['the colony series of a branch are merged'] },
  { name: 'the colony series of a branch whose history is kept are restored anyway', find: '{ name, requested: row.requested, policy: row.policy, locked: row.locked,', replace: '{ name, requested: row.requested, policy: \'replace\', locked: null,', fails: ['a branch whose timeline is not the stored one keeps its colony'] },
  { name: 'a stored colony file that cannot be read is replaced', find: 'if (!view.locked && !usableFile(stored)) {', replace: 'if (false) {', fails: ['a branch whose timeline is not the stored one keeps its colony'] },
  { name: 'a backup with no colony file for a branch shows a colony row for it', find: 'isObject(given.colonies[branchId]) ? given.colonies[branchId] : null', replace: 'isObject(given.colonies[branchId]) ? given.colonies[branchId] : { races: {} }', fails: ['a backup made before colony coverage', 'a safety copy taken'] },
  { name: 'a backup does not say it records the colony files', find: 'branches, colonyCoverage: true, ...(', replace: 'branches, ...(', fails: ['the colony series of each branch go into', 'a safety copy taken'] },
  { name: 'a replace of a backup with coverage keeps the stored series it lacks', find: 'view.policy === \'replace\' && !covered ?', replace: 'view.policy === \'replace\' ?', fails: ['the colony series of a branch are merged', 'a safety copy taken'] },
  { name: 'a stored colony file is not considered when the backup holds none for the branch', find: 'if (offered || (covered && isObject(heldColonies)', replace: 'if (offered || (false && isObject(heldColonies)', fails: ['a safety copy taken'] },
  { name: 'a colony file a restore empties is left as an empty file', find: 'const emptied = !offered && !Object.keys(result).length', replace: 'const emptied = false', fails: ['a safety copy taken'] },
  { name: 'a backup is taken to cover the colony files whether or not it says so', find: 'const covered = given.colonyCoverage === true', replace: 'const covered = true', fails: ['a backup made before colony coverage', 'the colony series of a branch are merged'] },
  { name: 'a colony coverage that is not true is accepted', find: 'envelope.version >= COLONY_COVERAGE_VERSION ? campaign.colonyCoverage !== true : campaign.colonyCoverage !== undefined', replace: 'false', fails: ['a backup whose colony series are malformed'] },
  { name: 'a colony file that cannot be read is left out of a backup that covers the colony files', find: 'if (series !== undefined && series !== null && !(isObject(series) && Object.keys(series).length === 0)) {', replace: 'if (isObject(series) && isObject(series.races)) {', fails: ['a stored colony file this version cannot read'] },
  { name: 'the colony file of a backup is not checked as it is built', find: 'checkColonyFile(series, `Campaign $' + '{id} branch $' + '{branchId} colony series`)', replace: 'void series', fails: ['a stored colony file this version cannot read'] },
  { name: 'a colony file with nothing in it is refused as unreadable', find: '!(isObject(series) && Object.keys(series).length === 0)) {', replace: 'true) {', fails: ['a stored colony file this version cannot read'] },
  { name: 'a backup of version 2 may leave out its colony coverage', find: 'envelope.version >= COLONY_COVERAGE_VERSION ? campaign.colonyCoverage !== true : campaign.colonyCoverage !== undefined', replace: 'envelope.version >= COLONY_COVERAGE_VERSION ? (campaign.colonyCoverage !== undefined && campaign.colonyCoverage !== true) : campaign.colonyCoverage !== undefined', fails: ['a backup says it covers the colony files', 'a backup whose colony series are malformed'] },
  { name: 'a backup of version 1 may state colony coverage', find: 'envelope.version >= COLONY_COVERAGE_VERSION ? campaign.colonyCoverage !== true : campaign.colonyCoverage !== undefined', replace: 'envelope.version >= COLONY_COVERAGE_VERSION ? campaign.colonyCoverage !== true : false', fails: ['a backup whose colony series are malformed'] },
  { name: 'a backup is written as version 2', find: 'export const VERSION = 3', replace: 'export const VERSION = 2', fails: ['a backup is of version 3'] },
  { name: 'the colony files are not counted with the history files', find: '[file, ...(file.colonies ? [file.colonies] : []), ...(file.events ? [file.events] : [])]', replace: '[file, ...(file.events ? [file.events] : [])]', fails: ['a preview of colony series writes nothing'] },
  { name: 'the event archives of a backup are not checked', find: 'Object.entries(campaign.events).forEach(([branchId, file]) => checkEventFile(', replace: 'Object.entries({}).forEach(([branchId, file]) => checkEventFile(', fails: ['a backup whose event archives are malformed'] },
  { name: 'an event archive with nothing in it is accepted in a backup', find: 'if (!isObject(file) || !Object.keys(file).length) {\n    bad(where, \'is not an event archive\')', replace: 'if (!isObject(file)) {\n    bad(where, \'is not an event archive\')', fails: ['a backup whose event archives are malformed'] },
  { name: 'a campaign may not hold event archives', find: '\'events\', \'eventCoverage\'], where)', replace: '\'eventCoverage\'], where)', fails: ['the event archive of each branch goes into'] },
  { name: 'a backup leaves the event archives out', find: '...(Object.keys(events).length ? { events } : {})', replace: '...({})', fails: ['the event archive of each branch goes into', 'the event archives of a branch are merged', 'a restore of event archives is undone'] },
  { name: 'the event archives of a restore are not written', find: 'writes.files.push(archive.write)', replace: 'void archive.write', fails: ['the event archive of each branch goes into', 'a preview of event archives writes nothing', 'the event archives of a branch are merged'] },
  { name: 'a replace of a backup with coverage keeps the stored races it lacks', find: '} else if (view.policy === \'replace\' && covered) {', replace: '} else if (false) {', fails: ['the event archives of a branch are merged', 'a safety copy taken before a restore that adds event archives'] },
  { name: 'a merge overwrites the stored record of a race', find: 'stat.conflicts = offer', replace: 'stat.conflicts = offer; result[RaceID] = clone(theirs)', fails: ['the event archives of a branch are merged'] },
  { name: 'the races chosen are not honoured for the event archives', find: '.sort((a, b) => Number(a) - Number(b)).filter(chosen)', replace: '.sort((a, b) => Number(a) - Number(b))', fails: ['the event archives of a branch are merged'] },
  { name: 'the event archive of a branch whose history is kept is restored anyway', find: 'kind: \'events\', name, requested: row.requested, policy: row.policy, locked: row.locked,', replace: 'kind: \'events\', name, requested: row.requested, policy: \'replace\', locked: null,', fails: ['a branch whose timeline is not the stored one keeps its event archive'] },
  { name: 'a stored event archive that cannot be read is replaced', find: 'if (!view.locked && unreadable) {', replace: 'if (false) {', fails: ['a branch whose timeline is not the stored one keeps its event archive'] },
  { name: 'a backup with no archive for a branch shows an event row for it', find: 'isObject(given.events[branchId]) ? given.events[branchId] : null', replace: 'isObject(given.events[branchId]) ? given.events[branchId] : { version: 1, races: {} }', fails: ['a backup made before event archives', 'a safety copy taken before a restore that adds event archives'] },
  { name: 'a backup does not say it records the event archives', find: 'eventCoverage: true, ...(Object.keys(events).length', replace: '...(Object.keys(events).length', fails: ['the event archive of each branch goes into', 'a safety copy taken before a restore that adds event archives'] },
  { name: 'a backup is taken to cover the event archives whether or not it says so', find: 'const eventsCovered = given.eventCoverage === true', replace: 'const eventsCovered = true', fails: ['a backup made before event archives'] },
  { name: 'an event coverage that is not true is accepted', find: 'envelope.version >= EVENT_COVERAGE_VERSION ? campaign.eventCoverage !== true : campaign.eventCoverage !== undefined || campaign.events !== undefined', replace: 'false', fails: ['a backup whose event archives are malformed', 'a backup is of version 3'] },
  { name: 'a backup of version 1 or 2 may hold event archives', find: ': campaign.eventCoverage !== undefined || campaign.events !== undefined) {', replace: ': campaign.eventCoverage !== undefined) {', fails: ['a backup whose event archives are malformed'] },
  { name: 'a backup of version 3 may leave out its event coverage', find: 'envelope.version >= EVENT_COVERAGE_VERSION ? campaign.eventCoverage !== true :', replace: 'envelope.version >= EVENT_COVERAGE_VERSION ? (campaign.eventCoverage !== undefined && campaign.eventCoverage !== true) :', fails: ['a backup is of version 3', 'a backup whose event archives are malformed'] },
  { name: 'an event archive that cannot be read is left out of a backup that covers the event archives', find: 'if (unreadable) {\n        throw new Rejected(', replace: 'if (false) {\n        throw new Rejected(', fails: ['a stored event archive this version cannot read'] },
  { name: 'the event archives are not counted with the history files', find: '...(file.events ? [file.events] : [])])', replace: '])', fails: ['a preview of event archives writes nothing'] },
  { name: 'the events of an archive are counted with the snapshots', find: 'filter((file) => file.kind !== \'events\')', replace: 'filter(() => true)', fails: ['a preview of event archives writes nothing'] },
  { name: 'a replace of event archives asks for no confirmation', find: 'if (droppedEvents) {', replace: 'if (false) {', fails: ['the event archives of a branch are merged'] },
  { name: 'a restored absence of an archive is written as no file', find: 'const file = { version: EVENT_ARCHIVE_VERSION, races: result }', replace: 'const file = !offered && !Object.keys(result).length ? {} : { version: EVENT_ARCHIVE_VERSION, races: result }', fails: ['a safety copy taken before a restore that adds event archives', 'a covered Replace that restores the absence'] },
  { name: 'the failures of a race record are dropped from a restored archive', find: 'result[RaceID] = clone(theirs)\n        stat.added = offer', replace: 'result[RaceID] = { ...clone(theirs), failures: undefined }\n        stat.added = offer', fails: ['a race record that carries failures'] },
  { name: 'a stored event archive is not considered when the backup holds none for the branch', find: 'if (offeredEvents || inherited || (eventsCovered && isObject(heldEvents)', replace: 'if (offeredEvents || inherited || (false && isObject(heldEvents)', fails: ['a safety copy taken before a restore that adds event archives'] },
  { name: 'the event archives of a backup are not checked by the file check', find: 'const problem = eventFileProblem(file)\n\n  if (problem) {\n    bad(where', replace: 'const problem = null\n\n  if (problem) {\n    bad(where', fails: ['a backup whose event archives are malformed'] },
  { name: 'a covered Replace of a fork that has no file but could inherit is not planned', find: 'if (offeredEvents || inherited || (eventsCovered', replace: 'if (offeredEvents || (eventsCovered', fails: ['a covered Replace of an unmarked fork'] },
  { name: 'a fork that could inherit nothing is planned too', find: 'const inherited = isObject(base.races) && Object.keys(base.races).length ? base.races : null', replace: 'const inherited = isObject(base.races) ? base.races : {}', fails: ['a covered Replace of an unmarked fork'] },
  { name: 'a Replace of an inheriting fork does not start from what it inherits', find: 'inherited && view.policy === \'replace\' && covered ? inherited : {}', replace: '{}', fails: ['a covered Replace of an unmarked fork'] },
  { name: 'what a fork would inherit is read from the stores as they stand before the restore', find: 'eventBase(afterRestore, { id: given.id', replace: 'eventBase(io, { id: given.id', fails: ['a Replace of a parent and its unmarked fork'] },
  { name: 'the event archives are planned in numeric order, not in ancestry order', find: '.sort((a, b) => depthOf(a) - depthOf(b) || branchOrder(a, b))', replace: '', fails: ['a lineage numbered in reverse'] },
  { name: 'the event archive of a branch is not remembered for the branches planned after it', find: 'plannedEvents.set(archive.write.name, archive.write.value)', replace: 'void archive.write.value', fails: ['a Replace of a parent and its unmarked fork'] },
]

// The source of the utilities as it stands, by file name, read once: what a mutant is planted in. The mutated text is made in the child that runs it, from this text.
const unmutated = new Map()

const sourceOf = (file) => {
  if (!unmutated.has(file)) {
    unmutated.set(file, fs.readFileSync(path.join(repo, file), 'utf8').replace(/\r\n/g, '\n'))
  }

  return unmutated.get(file)
}

// The text of the module a mutant changes, with the change made, or an error when the text to replace is not there exactly once. The loader is given it in place of the module's own file, so no copy of the utilities is made and every other module is read from where it is.
const plantedSource = (mutant) => {
  const source = sourceOf(mutant.file || MODULE_FILE)

  if (source.split(mutant.find).length !== 2) {
    throw new Error(`The mutant "${mutant.name}" does not apply exactly once`)
  }

  return source.replace(mutant.find, () => mutant.replace)
}

// The module name the loader knows a file by: 'src/renderer/utilities/history-backup.js' is 'renderer/utilities/history-backup'.
const moduleNameOf = (file) => file.replace(/^src\//, '').replace(/\.js$/, '')

// The checks `only` names (all of them for null) of the sources with the mutant at `index` of MUTANTS planted, or as they stand for no mutant, run in a Node process of its own (the modules hold state, and a mutant must not leak into the next one): { results, lines } where `lines` is what the process printed besides its results.
const checksInChild = (only, index = null) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [__filename], { env: { ...process.env, HISTORY_BACKUP_ONLY: JSON.stringify(only), HISTORY_BACKUP_MUTANT: index === null ? '' : String(index) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let errors = ''

  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { errors += chunk })
  child.on('error', reject)
  child.on('close', (code) => {
    const rows = out.split('\n')
    const line = rows.find((row) => row.startsWith(RESULT_PREFIX))

    if (code !== 0 || !line) {
      reject(new Error(`The checks ${index === null ? 'of the sources' : `of the mutant ${index}`} ended with ${code}: ${errors.trim().slice(0, 400)}`))
    } else {
      resolve({ results: JSON.parse(line.slice(RESULT_PREFIX.length)), lines: rows.filter((row) => row !== line && row !== '') })
    }
  })
})

const tryMutant = async (mutant, index) => {
  try {
    plantedSource(mutant)

    const { results } = await checksInChild(mutant.fails, index)
    const survived = mutant.fails.filter((start) => !results.some(([, name, result]) => name.startsWith(start) && result !== true))
    const missing = mutant.fails.filter((start) => !results.some(([, name]) => name.startsWith(start)))

    return [`mutant caught: ${mutant.name} (fails: ${mutant.fails.join('; ')})`, survived.length === 0 && missing.length === 0 ? true : `${missing.length ? `no check starts with: ${missing.join('; ')}. ` : ''}${survived.length ? `these checks still pass: ${survived.join('; ')}` : ''}`]
  } catch (error) {
    return [`mutant caught: ${mutant.name}`, error.message]
  }
}

const main = async () => {
  if (process.env.HISTORY_BACKUP_ONLY) {
    const mutant = process.env.HISTORY_BACKUP_MUTANT === '' ? null : MUTANTS[Number(process.env.HISTORY_BACKUP_MUTANT)]
    const sources = mutant ? { [moduleNameOf(mutant.file || MODULE_FILE)]: plantedSource(mutant) } : {}
    const results = await runSuite(await loadModules(src, sources), JSON.parse(process.env.HISTORY_BACKUP_ONLY))

    console.log(RESULT_PREFIX + JSON.stringify(results))
    process.exit(0)
  }

  const mutating = !process.argv.includes('--no-mutations')
  const names = [...new Set(MUTANTS.flatMap((mutant) => mutant.fails))]
  // The checks of the sources, the control run of the unchanged sources and the mutants all run side by side, the long ones first, so the slowest check does not run alone at either end.
  const outcomes = await inParallel([null, ...(mutating ? [names, ...MUTANTS] : [])], (item, at) => (at === 0 ? checksInChild(null) : at === 1 ? checksInChild(item).catch((error) => error) : tryMutant(item, at - 2)))

  if (outcomes[0] instanceof Error) {
    throw outcomes[0]
  }

  const { results, lines } = outcomes[0]
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

  lines.forEach((line) => console.log(line))

  results.forEach(([next, name, result]) => {
    if (next !== group) {
      group = next
      console.log(`\n${group}`)
    }

    show(name, result)
  })

  if (mutating) {
    console.log('\nmutants')

    outcomes.slice(2).forEach((outcome, at) => (outcome instanceof Error ? show(`mutant caught: ${MUTANTS[at].name}`, outcome.message) : show(...outcome)))

    const control = outcomes[1] instanceof Error ? outcomes[1] : outcomes[1].results
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
