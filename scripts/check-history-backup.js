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

  Mutants: each of a list of deliberate faults in a copy of the module is run, with the checks it names, in a Node process of its own on a copied tree; it is caught when each named check fails there. A control run of the unchanged copy must pass every check the mutants name. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const assert = require('assert').strict
const { loadUtilities } = require('./lib/utilities')

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

const loadModules = async (base) => {
  const names = ['history-backup', 'campaign', 'history', 'scenario-records', 'recording-owner'].map((name) => `renderer/utilities/${name}`)
  const loaded = await loadUtilities(names, { stubs: STUBS, directory: base })

  return { backup: loaded[names[0]], campaign: loaded[names[1]], history: loaded[names[2]], records: loaded[names[3]], owner: loaded[names[4]] }
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// ---- Installations ----------------------------------------------------------------------------------------------------

// The stores of one installation: each a JSON value read and written whole, as electron-store's `.store` is, with the store client's whole-file `update`. `dir` mirrors every write as a file, so a check can compare the bytes of the installation before and after. `hooks.beforeWrite(name, index)` can throw to stand for a full disk.
const installation = ({ dir = null, first = 1 } = {}) => {
  const files = new Map()
  const writes = []
  const hooks = { beforeWrite: null }
  const put = (name, value) => {
    files.set(name, clone(value))

    if (dir) {
      fs.writeFileSync(path.join(dir, `${encodeURIComponent(name)}.json`), JSON.stringify(value))
    }
  }
  const store = (name) => ({
    get store () {
      return clone(files.get(name)) || {}
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
    snapshot: () => JSON.stringify([...files].sort(([a], [b]) => (a < b ? -1 : 1))),
    bytes: () => {
      const hash = crypto.createHash('sha256')

      fs.readdirSync(dir).sort().forEach((name) => hash.update(name).update(fs.readFileSync(path.join(dir, name))))

      return hash.digest('hex')
    },
    registry: () => ({ campaigns: {}, pool: {}, ...(clone(files.get('registry')) || {}) }),
    fileOf: (campaignId, branchId = 'b1') => clone(files.get(`file:campaign-${campaignId}-${branchId}`)) || {},
  }

  return inst
}

// ---- The suite --------------------------------------------------------------------------------------------------------

const defineSuite = (m) => {
  const checks = []
  const check = (group, name, run) => checks.push({ group, name, run })
  const { backup, campaign, records, history } = m

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
    refused(edited((doc) => { doc.version = 2 }), /version 2, written by a newer version/)
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
      const attempts = [edited((doc) => { doc.version = 2 }), edited((doc) => { doc.campaigns[0].branches.b1.races[1].snapshots.reverse() }), '{', 'x'.repeat(backup.MAX_BYTES + 1)]

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
  { name: 'the coverage of a series is not compared', find: 'if (!isObject(series.coverage) || series.coverage.count !== count || series.coverage.first !== first || series.coverage.last !== last || Object.keys(series.coverage).length !== 3) {', replace: 'if (false) {', fails: ['a series whose coverage'] },
  { name: 'the size of a file is checked after it is parsed', find: 'if (!fitsLimit(body)) {', replace: 'if (false) {', fails: ['a file larger than the limit'] },
  { name: 'a campaign id may name a path', find: 'const ID = /^[A-Za-z0-9_-]+$/', replace: 'const ID = /^.+$/', fails: ['an id that could name'] },
  { name: 'a race id need not be canonical', find: 'const NUMERIC = /^(0|[1-9]\\d*)$/', replace: 'const NUMERIC = /^[0-9.]+$/', fails: ['an id that could name'] },
  { name: 'a branch id may be anything', find: 'const BRANCH = /^b[1-9]\\d*$/', replace: 'const BRANCH = /^.+$/', fails: ['an id that could name'] },
  { name: 'the backup wins at a shared game time under merge', find: 'const united = [...stored, ...given.filter((snapshot) => !known.has(snapshot.t))].sort(', replace: 'const united = [...stored.filter((snapshot) => !offered.has(snapshot.t)), ...given].sort(', fails: ['a merge keeps the stored snapshot', 'a stored snapshot at a shared game time'] },
  { name: 'what passes the cap is not thinned', find: 'const thinned = thinSnapshots(united)', replace: 'const thinned = united', fails: ['a merge keeps the stored snapshot'] },
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
]

// The utilities copied, with one mutant applied, to the layout the loader reads: `<root>/src/renderer/utilities`. The mutant's `file` is relative to the root.
const mutatedTree = (mutant) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-history-backup-mutant-'))

  fs.cpSync(path.join(src, 'renderer', 'utilities'), path.join(directory, 'src', 'renderer', 'utilities'), { recursive: true })

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

// The checks `only` names of one tree, run in a Node process of its own (the modules hold state, and a mutant must not leak into the next tree).
const checksInChild = (tree, only) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [__filename], { env: { ...process.env, HISTORY_BACKUP_TREE: tree, HISTORY_BACKUP_ONLY: JSON.stringify(only) }, stdio: ['ignore', 'pipe', 'pipe'] })
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

// `items` through `work`, no more than `limit` at a time, the results in the order of the items.
const inParallel = async (items, limit, work) => {
  const results = new Array(items.length)
  let next = 0

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++

      results[index] = await work(items[index])
    }
  }))

  return results
}

const main = async () => {
  if (process.env.HISTORY_BACKUP_TREE) {
    const results = await runSuite(await loadModules(process.env.HISTORY_BACKUP_TREE), JSON.parse(process.env.HISTORY_BACKUP_ONLY))

    console.log(RESULT_PREFIX + JSON.stringify(results))
    process.exit(0)
  }

  const results = await runSuite(await loadModules(src))
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

  results.forEach(([next, name, result]) => {
    if (next !== group) {
      group = next
      console.log(`\n${group}`)
    }

    show(name, result)
  })

  if (!process.argv.includes('--no-mutations')) {
    console.log('\nmutants')

    const names = [...new Set(MUTANTS.flatMap((mutant) => mutant.fails))]

    for (const [name, result] of await inParallel(MUTANTS, 4, tryMutant)) {
      show(name, result)
    }

    let control = null
    let directory = null

    try {
      directory = mutatedTree(null)
      control = await checksInChild(path.join(directory, 'src'), names)
    } catch (error) {
      control = error
    } finally {
      if (directory) {
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }

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
