/*
  Checks the milestones of the history page (utilities/history-milestones.js and the Milestones panel of src/renderer/pages/history.vue): notes pinned to an exact game time, with an optional link to one object of the save.

  node scripts/check-history-milestones.js [--no-mutations]

  MILESTONES_SAVES=<folder> points the saves check at another folder of saves (or at none: a folder that is not there skips it). A check that needs the owner's saves and does not find them is reported as skipped, is not counted, and no mutant is expected to fail it.

  Groups:
  - time: a milestone between two samples keeps its exact time to the last digit, its marker is drawn at that time whatever the samples are (another set of samples, a span, a thinned history), it never snaps to a sample, the nearest sample is only reported beside it, the time survives a restart, and a typed date is the calendar date of the game's own clock;
  - edits: a new milestone, an edit, a delete, a stale edit refused with the stored milestone and written over only when asked, a stale delete refused, a milestone the adapter refuses is not written, and the other fields of an edit are kept;
  - branches: a campaign milestone shows on every branch of the campaign and a branch milestone only on its own, a rewound save lists a later milestone as ahead and does not draw it, and only an explicit move brings it to the save, with its time unchanged;
  - links: a deleted object leaves the milestone with an unresolved link that is never rebound by name, an ID reused by another object is changed, a renamed colony, system, fleet or ship stays linked and shows its new name, a link to a kind of object the save could not give is unknown and never missing, an edit keeps the link it has unless a link is given, and a log event is named by its increment, its content and the place it names, never by the row number of SQLite (no query asks for it, and a link made in one save resolves in a save whose rows were all renumbered); rows that say the same in two places are two events, and rows that are the same in every field are one ambiguous event; every linked increment is read, in batches, however many there are; a link keeps the campaign and branch it was made on, is linked there whatever the ID, and on another branch of the campaign is certified only when the object demonstrably predates the two branches parting (a ship or system by its time, a colony by its place, a fleet never), else it is unknown and not unresolved;
  - scope: a link is made only against the objects of the race it is kept for, and only for an object that is there as it was picked;
  - attached: after an attach (merged into the same branch, or as a branch of its own) the milestones of the attached campaign are listed apart, never drawn, never merged on a read, and adopted only on request, once; a source file that cannot be read is named; a milestone adopted onto one branch reads as adopted on every branch of the campaign and names the branch that holds the copy;
  - saves: on the owner's consecutive saves of artifacts/boscodiogigia-sequential-saves (opened read only, skipped when they are not here) the objects load with the real queries, the objects both saves hold keep their fingerprint, the log rows shared by two saves keep their increment and content and lose their row number, and a link to an event made in the earlier save resolves in the later one;
  - backup: milestones round-trip through the backup's annotation adapter with their exact time, link and policy, a kind the installation has no adapter for is refused, and a backup without milestones leaves them as they are;
  - page: the Milestones panel names what it is for in the page's voice, every chart carries the markers at the exact time, also on the percent scale and in another span, the form keeps the exact time of a milestone it edits, a stale edit is not written over silently, a draft is dropped and refused when the campaign, race or branch shown changes, objects read for another save or race are not used, the attached campaigns' milestones are listed apart and adopted on request, and the backup registers the adapter.

  Everything runs on in-memory stores and the real scenario repository. Each mutation of the utility or of the page must fail the checks it names. Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('assert').strict
const { createRequire } = require('module')
const { loadUtilities } = require('./lib/utilities')
const { loadPage, instantiate, replacing } = require('./lib/page-loader')

const root = path.resolve(__dirname, '..')
const utilitiesDirectory = path.join(root, 'src', 'renderer', 'utilities')
const pageFile = path.join(root, 'src', 'renderer', 'pages', 'history.vue')
const SAVES = process.env.MILESTONES_SAVES || path.join(root, 'artifacts', 'boscodiogigia-sequential-saves')
const NAMES = ['history-milestones', 'scenario-records', 'history-backup']
const START_YEAR = 2050
const YEAR = 31536000
const DAY = 86400

const requireOf = (specifier) => `createRequire(${JSON.stringify(path.join(root, 'package.json'))})(${JSON.stringify(specifier)})`

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
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

  const make = (extra = {}) => m.records.createRepository({ storage: inst.storage, adapters: registry, newId: () => uuid(++ids), now: () => ++clock, ...extra })

  return { inst, registry, make, repo: make() }
}

const scope = (branchId = 'b1', gameTime = 100000, campaignId = 'c1', RaceID = 7) => ({ campaignId, RaceID, branchId, gameTime })

// A campaign of the registry as the campaign module writes it, complete enough for its own reader to accept; `mergedInto` marks it as attached to another.
const campaignEntry = (campaignId, mergedInto) => ({ id: campaignId, names: [], gameIds: [], anchor: [], attachments: [], branches: { b1: { id: 'b1', tip: { n: 0, digest: '0', checkpoints: [] } } }, branchSeq: 1, ...(mergedInto ? { mergedInto } : {}) })

const placeOf = (event) => ({ SystemID: event.systemId, PopulationID: event.populationId, Xcor: event.xcor, Ycor: event.ycor, IDType: event.idType })

// The branches of the campaign c1 as the registry holds them (`branchLineage`): b2 left b1 at game time 1000, b3 left b1 at 3000 and b4 left b2 at 500.
const TREE = { b1: { parent: null, t: null }, b2: { parent: 'b1', t: 1000 }, b3: { parent: 'b1', t: 3000 }, b4: { parent: 'b2', t: 500 } }

// The objects of an open save as `loadObjects` gives them for race 7 of game 1, with the campaign and branch the save is open on (the page adds them).
const objectsOf = (m, { colonies = [], systems = [], fleets = [], ships = [], events = [], campaignId = 'c1', branchId = 'b1', branches = TREE } = {}) => {
  const of = (type, rows) => new Map(rows.map((row) => [row.id, { type, ...row }]))
  const eventRows = new Map()

  events.forEach((event) => {
    const key = m.milestones.eventKey({ IncrementID: event.incrementId, Time: event.time, EventType: event.eventType, MessageText: event.name, ...placeOf(event) })

    eventRows.set(key, { type: 'event', id: key, copies: 1, ...event })
  })

  return { GameID: 1, RaceID: 7, campaignId, branchId, branches, failed: {}, objects: { colony: of('colony', colonies), system: of('system', systems), fleet: of('fleet', fleets), ship: of('ship', ships), event: eventRows } }
}

const colony = (id, name, systemId = 1, bodyId = 100, speciesId = 7) => ({ id, name, systemId, bodyId, speciesId })

const system = (id, name, number = id, stars = 1, discovered = 0) => ({ id, name, number, stars, discovered })

const fleet = (id, name, created = 0) => ({ id, name, created })

const ship = (id, name, constructed = 0) => ({ id, name, constructed })

const link = (type, row) => ({ type, row: { type, ...row } })

// The objects a link is picked from, as the page hands them to a save: the picked row alone, for the race, campaign and branch of `where`.
const contextOf = (where, ...links) => ({ GameID: 1, RaceID: where.RaceID, campaignId: where.campaignId, branchId: where.branchId, branches: TREE, objects: Object.fromEntries([...new Set(links.map((one) => one.type))].map((type) => [type, new Map(links.filter((one) => one.type === type).map((one) => [one.row.id, one.row]))])) })

// The objects `loadObjects` read, as the page hands them to a save: with the campaign and branch the save is open on.
const contextFor = (loaded, where = scope()) => ({ ...loaded, campaignId: where.campaignId, branchId: where.branchId, branches: TREE })

// ---- A fake save: the tables the object queries read, with the row numbers SQLite gives the log -------------------------

// `save.events` are the rows of the log as { rowid, IncrementID, Time, EventType, MessageText }. The fake answers the SQL of the utility by the table it names and never reads a column the real query did not ask for, except that every log row carries its rowid and RowID (what a faulty query would use), and it records the SQL it was sent.
const fakeSave = (save, { failing = [] } = {}) => {
  const sent = []

  return {
    sent,
    query: async (sql) => {
      sent.push(sql)

      const failed = failing.find((table) => sql.includes(table))

      if (failed) {
        throw new Error(`no such table: ${failed}`)
      }

      if (sql.includes('from FCT_Population')) {
        return [save.colonies.map((row) => ({ PopulationID: row.id, PopName: row.name, SpeciesID: row.speciesId, SystemID: row.systemId, SystemBodyID: row.bodyId }))]
      }

      if (sql.includes('from FCT_RaceSysSurvey')) {
        return [save.systems.map((row) => ({ SystemID: row.id, Name: row.name, SystemNumber: row.number, Stars: row.stars, DiscoveredTime: row.discovered }))]
      }

      if (sql.includes('from FCT_Fleet')) {
        return [save.fleets.map((row) => ({ FleetID: row.id, FleetName: row.name, CreatedTime: row.created }))]
      }

      if (sql.includes('from FCT_Ship')) {
        return [save.ships.map((row) => ({ ShipID: row.id, ShipName: row.name, Constructed: row.constructed }))]
      }

      if (sql.includes('from FCT_GameLog')) {
        const recent = /limit \d+\)/.test(sql)
        const listed = (/FCT_GameLog\.IncrementID in \(([\d, ]+)\)$/.exec(sql) || [null, ''])[1].split(',').map((part) => Number(part.trim()))
        const increments = [...new Set(save.events.map((row) => row.IncrementID))].sort((a, b) => b - a)
        const wanted = new Set(recent ? increments.slice(0, 60) : listed)

        return [save.events.filter((row) => wanted.has(row.IncrementID)).map((row) => ({ ...row, RowID: row.rowid }))]
      }

      throw new Error(`the fake save does not answer ${sql}`)
    },
  }
}

// ---- The suite -------------------------------------------------------------------------------------------------------

const suite = (m) => {
  const checks = []
  const check = (group, name, run) => checks.push({ group, name, run })
  const { milestones } = m

  const make = (overrides = {}) => {
    const w = world(m)

    return {
      ...w,
      add: (where, extra = {}) => {
        const given = { t: 5000, type: 'battle', text: 'Battle of the pass', ...extra, ...overrides }

        return milestones.saveMilestone(w.repo, where, given.link && !('context' in given) ? { ...given, context: contextOf(where, given.link) } : given)
      },
    }
  }

  const entriesOf = (w, where, context = null) => milestones.readMilestones(w.repo, where, context).entries

  const added = async (w, where, extra = {}) => {
    const outcome = await w.add(where, extra)

    assert.equal(outcome.ok, true, outcome.message)

    return outcome.record
  }

  // The x a chart gives a game time (the page's `year`): the calendar year, fractions included.
  const position = (seconds) => START_YEAR + seconds / YEAR

  const snapshotsAt = (times) => times.map((t) => ({ t }))

  // ---- time ---------------------------------------------------------------------------------------------------------

  check('time', 'a milestone between two samples keeps its exact position: its marker is at its time, not at a sample', async () => {
    const w = make()
    const samples = snapshotsAt([1000, 2000, 3000])

    await added(w, scope(), { t: 1337 })

    const [entry] = entriesOf(w, scope())
    const markers = milestones.markersOf([entry], samples, position)

    assert.equal(entry.t, 1337)
    assert.equal(markers.length, 1)
    assert.equal(markers[0].x, position(1337))
    assert.notEqual(markers[0].x, position(1000))
    assert.notEqual(markers[0].x, position(2000))
  })

  check('time', 'the nearest sample is reported beside the milestone and the milestone keeps its own time', async () => {
    const w = make()

    await added(w, scope(), { t: 1337 })

    const [entry] = entriesOf(w, scope())

    assert.deepEqual(milestones.nearestSample(snapshotsAt([1000, 2000]), entry.t), { sampleT: 1000, offset: 337 })
    assert.deepEqual(milestones.nearestSample(snapshotsAt([1000, 2000]), 1500), { sampleT: 1000, offset: 500 })
    assert.deepEqual(milestones.nearestSample(snapshotsAt([1000, 2000]), 1800), { sampleT: 2000, offset: -200 })
    assert.equal(milestones.nearestSample([], 5), null)
    assert.equal(entriesOf(w, scope())[0].t, 1337)
  })

  check('time', 'the marker x is a function of the exact time alone: other samples, a narrower span and a thinned history leave it', async () => {
    const w = make()

    await added(w, scope(), { t: 123456 })
    await added(w, scope(), { t: 654321 })

    const entries = entriesOf(w, scope())
    const dense = snapshotsAt(Array.from({ length: 80 }, (_, index) => index * 10000))
    const sparse = snapshotsAt([0, 400000, 800000])
    const narrow = snapshotsAt([100000, 700000])
    const expected = [position(123456), position(654321)]

    for (const samples of [dense, sparse, narrow]) {
      assert.deepEqual(milestones.markersOf(entries, samples, position).map((marker) => marker.x), expected)
    }
  })

  check('time', 'a milestone outside the samples shown is not drawn, and one at the first or last sample is', async () => {
    const w = make()

    await added(w, scope(), { t: 500 })
    await added(w, scope(), { t: 1000 })
    await added(w, scope(), { t: 3000 })
    await added(w, scope(), { t: 3001 })

    const drawn = milestones.markersOf(entriesOf(w, scope(), null), snapshotsAt([1000, 2000, 3000]), position).map((marker) => marker.x)

    assert.deepEqual(drawn, [position(1000), position(3000)])
    assert.equal(milestones.withinSamples([], 5), false)
  })

  check('time', 'the exact time, fractions included, is the same after a restart (the file read by another repository)', async () => {
    const inst = memory()
    const first = world(m, inst)

    for (const t of [0, 1, 86399, 31536000 * 3 + 12345, 1337.123456, 226445245]) {
      assert.equal((await milestones.saveMilestone(first.repo, scope(), { t, type: 'other', text: `at ${t}` })).ok, true)
    }

    const again = world(m, inst)

    assert.deepEqual(entriesOf(again, scope()).map((entry) => entry.t), [0, 1, 1337.123456, 86399, 31536000 * 3 + 12345, 226445245])
    assert.deepEqual(entriesOf(first, scope()).map((entry) => entry.t), entriesOf(again, scope()).map((entry) => entry.t))
  })

  check('time', 'a typed date is the calendar date of the game clock, both ways, with leap days and the start', () => {
    const dayjs = localRequire('dayjs')

    dayjs.extend(localRequire('dayjs/plugin/utc.js'))

    const calendar = (seconds) => dayjs.utc(0).set('year', START_YEAR).set('hour', 0).set('minute', 0).set('second', 0).add(seconds, 'second').format('YYYY-MM-DD HH:mm:ss')

    for (const seconds of [0, 59, 86400, 86399, 31536000 * 2 + 40 * DAY + 3661, 1500 * DAY + 7, 226445245, 1277161332]) {
      const text = milestones.gameDateText(START_YEAR, seconds)

      assert.equal(text, calendar(seconds))
      assert.deepEqual(milestones.gameSecondsOf(START_YEAR, text), { ok: true, seconds })
    }

    assert.deepEqual(milestones.gameSecondsOf(START_YEAR, '2050-01-01'), { ok: true, seconds: 0 })
    assert.deepEqual(milestones.gameSecondsOf(START_YEAR, '2050-01-02 01:02'), { ok: true, seconds: DAY + 3720 })
    assert.equal(milestones.gameSecondsOf(START_YEAR, '2052-02-29').ok, true)
  })

  check('time', 'a typed date that is no date of the calendar, is before the start or is not a date is refused with a reason', () => {
    for (const text of ['2051-02-29', '2050-02-30', '2050-13-01', '2050-01-01 25:00', '2050-01-01 10:61', '2049-12-31', 'yesterday', '', '2050-1-1']) {
      const outcome = milestones.gameSecondsOf(START_YEAR, text)

      assert.equal(outcome.ok, false, text)
      assert.ok(outcome.error.length > 10, text)
    }
  })

  // ---- edits --------------------------------------------------------------------------------------------------------

  check('edits', 'a milestone is made with a type, a text and an exact time, and is listed with them', async () => {
    const w = make()
    const record = await added(w, scope(), { t: 4242, type: 'colonisation', text: '  First colony ships landed  ' })
    const [entry] = entriesOf(w, scope())

    assert.equal(entry.uuid, record.uuid)
    assert.equal(entry.t, 4242)
    assert.equal(entry.type, 'colonisation')
    assert.equal(entry.text, 'First colony ships landed')
    assert.equal(entry.policy, 'campaign')
    assert.equal(entry.link, null)
    assert.equal(record.kind, milestones.MILESTONE_KIND)
    assert.equal(record.revision, 1)
  })

  check('edits', 'an edit changes the fields it names, keeps the rest and the uuid, and moves the revision on', async () => {
    const w = make()
    const colonies = [colony(5, 'Earth')]
    const record = await added(w, scope(), { t: 900, text: 'Landing', link: { type: 'colony', row: { type: 'colony', ...colonies[0] } } })
    const [entry] = entriesOf(w, scope(), objectsOf(m, { colonies }))
    const edited = await milestones.saveMilestone(w.repo, scope(), { entry, t: 950, type: 'discovery', text: 'Landing, corrected' })

    assert.equal(edited.ok, true, edited.message)
    assert.equal(edited.record.uuid, record.uuid)
    assert.equal(edited.record.revision, 2)

    const [after] = entriesOf(w, scope(), objectsOf(m, { colonies }))

    assert.equal(after.t, 950)
    assert.equal(after.type, 'discovery')
    assert.equal(after.text, 'Landing, corrected')
    assert.equal(after.link.id, 5)
    assert.equal(after.link.status, 'unknown')
    assert.equal(after.policy, 'campaign')
  })

  check('edits', 'a stale edit is refused with the stored milestone and writes nothing, and it is written over only when asked', async () => {
    const w = make()

    await added(w, scope(), { t: 100, text: 'first' })

    const [entry] = entriesOf(w, scope())
    const other = world(m, w.inst)

    assert.equal((await milestones.saveMilestone(other.repo, scope(), { entry, t: 100, type: 'battle', text: 'edited elsewhere' })).ok, true)

    const before = JSON.stringify(w.inst.files.get('campaign-c1'))
    const stale = await milestones.saveMilestone(w.repo, scope(), { entry, t: 100, type: 'battle', text: 'edited here' })

    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'revision-conflict')
    assert.equal(stale.stored.text, 'edited elsewhere')
    assert.equal(stale.revision, 2)
    assert.equal(JSON.stringify(w.inst.files.get('campaign-c1')), before)

    const over = await milestones.saveMilestone(w.repo, scope(), { entry, t: 100, type: 'battle', text: 'edited here', overwrite: true })

    assert.equal(over.ok, true, over.message)
    assert.equal(entriesOf(w, scope())[0].text, 'edited here')
    assert.equal(over.record.provenance.reconciled[0].staleRevision, 1)
  })

  check('edits', 'a delete removes the milestone, a stale delete is refused and nothing is deleted, and the uuid is never issued again', async () => {
    const w = make()

    await added(w, scope(), { text: 'one' })
    await added(w, scope(), { text: 'two' })

    const [first, second] = entriesOf(w, scope())
    const other = world(m, w.inst)

    assert.equal((await milestones.saveMilestone(other.repo, scope(), { entry: second, t: 5000, type: 'battle', text: 'two, changed' })).ok, true)

    const stale = await milestones.deleteMilestone(w.repo, scope(), second)

    assert.equal(stale.ok, false)
    assert.equal(stale.code, 'revision-conflict')
    assert.equal(entriesOf(w, scope()).length, 2)

    const gone = await milestones.deleteMilestone(w.repo, scope(), first)

    assert.equal(gone.ok, true, gone.message)
    assert.deepEqual(entriesOf(w, scope()).map((entry) => entry.text), ['two, changed'])
    assert.equal(Object.keys(w.inst.files.get('campaign-c1').tombstones).includes(first.uuid), true)
  })

  check('edits', 'a milestone the adapter refuses is not written: a negative or non-number time, an empty or long text, an unknown type or link, a stray field', async () => {
    const w = make()
    const bad = [{ t: -1 }, { t: Number.NaN }, { t: 'soon' }, { text: '   ' }, { text: 'x'.repeat(milestones.TEXT_LENGTH + 1) }, { type: 'party' }, { link: { type: 'planet', row: { id: 1, name: 'X' } } }]

    for (const extra of bad) {
      const outcome = await w.add(scope(), extra)

      assert.equal(outcome.ok, false, JSON.stringify(extra))
      assert.equal(outcome.code, 'invalid-milestone', JSON.stringify(extra))
    }

    assert.equal(w.inst.files.has('campaign-c1'), false)
    assert.ok(milestones.problemsOf({ t: 1, type: 'other', text: 'a', link: null, extra: 1 }).some((problem) => /extra/.test(problem)))
    assert.deepEqual(milestones.problemsOf({ t: 0, type: 'other', text: 'a', link: null }), [])
    assert.deepEqual(milestones.problemsOf({ t: 0, type: 'other', text: 'a' }), [])
  })

  check('edits', 'without a repository, a scope or the file\'s lock nothing is written and the reason is given', async () => {
    const w = make()

    assert.equal((await milestones.saveMilestone(null, scope(), { t: 1, type: 'other', text: 'a' })).code, 'no-repository')
    assert.equal((await milestones.saveMilestone(w.repo, null, { t: 1, type: 'other', text: 'a' })).code, 'no-scope')

    const locked = world(m, { ...memory(), storage: { ...memory().storage, writable: () => Promise.resolve(false) } })

    assert.equal((await milestones.saveMilestone(locked.repo, scope(), { t: 1, type: 'other', text: 'a' })).code, 'not-owner')
    assert.equal(milestones.readMilestones(null, scope()).entries.length, 0)
  })

  // ---- branches -----------------------------------------------------------------------------------------------------

  check('branches', 'a campaign milestone shows on every branch of the campaign and a branch milestone only on its own', async () => {
    const w = make()

    await added(w, scope('b1'), { text: 'whole campaign', policy: 'campaign' })
    await added(w, scope('b1'), { text: 'this branch only', policy: 'branch' })

    assert.deepEqual(entriesOf(w, scope('b1')).map((entry) => entry.text).sort(), ['this branch only', 'whole campaign'])
    assert.deepEqual(entriesOf(w, scope('b2')).map((entry) => entry.text), ['whole campaign'])
    assert.deepEqual(entriesOf(w, scope('b2')).map((entry) => entry.policy), ['campaign'])
    assert.equal(entriesOf(w, scope('b2', 100000, 'c2')).length, 0)
    assert.equal(entriesOf(w, scope('b2', 100000, 'c1', 8)).length, 0)
  })

  check('branches', 'a milestone made at a later game time than a rewound save is ahead: listed, not drawn, never moved by the rewind', async () => {
    const w = make()

    await added(w, scope('b1', 100000), { t: 90000, text: 'late' })
    await added(w, scope('b1', 100000), { t: 20000, text: 'early' })

    const rewound = scope('b1', 50000)
    const entries = entriesOf(w, rewound)
    const samples = snapshotsAt([0, 10000, 30000, 50000])
    const before = JSON.stringify(w.inst.files.get('campaign-c1'))

    assert.deepEqual(entries.map((entry) => [entry.text, entry.ahead]), [['early', true], ['late', true]])
    assert.deepEqual(milestones.markersOf(entries, samples, position), [])
    assert.equal(JSON.stringify(w.inst.files.get('campaign-c1')), before)
    assert.deepEqual(milestones.markersOf(entriesOf(w, scope('b1', 100000)), snapshotsAt([0, 50000, 100000]), position).map((marker) => marker.x), [position(20000), position(90000)])
  })

  check('branches', 'a milestone is brought to a rewound save only by an explicit move, with its time unchanged, and it is then drawn there', async () => {
    const w = make()

    await added(w, scope('b1', 100000), { t: 40000, text: 'carried' })

    const rewound = scope('b2', 60000)
    const [entry] = entriesOf(w, rewound)

    assert.equal(entry.ahead, true)
    assert.equal(entry.otherBranch, true)

    const moved = await milestones.moveMilestone(w.repo, rewound, entry)

    assert.equal(moved.ok, true, moved.message)

    const [after] = entriesOf(w, rewound)

    assert.equal(after.ahead, false)
    assert.equal(after.t, 40000)
    assert.equal(after.text, 'carried')
    assert.deepEqual(milestones.markersOf([after], snapshotsAt([0, 30000, 60000]), position).map((marker) => marker.x), [position(40000)])
    assert.equal((await milestones.moveMilestone(w.repo, rewound, entry)).code, 'revision-conflict')
  })

  check('branches', 'the policy of a milestone is chosen when it is made and can be edited: branch pins it to the branch that edits it', async () => {
    const w = make()

    await added(w, scope('b1'), { text: 'wide', policy: 'campaign' })

    const [entry] = entriesOf(w, scope('b1'))
    const pinned = await milestones.saveMilestone(w.repo, scope('b1'), { entry, t: 5000, type: 'battle', text: 'wide', policy: 'branch' })

    assert.equal(pinned.ok, true, pinned.message)
    assert.equal(entriesOf(w, scope('b2')).length, 0)
    assert.equal(entriesOf(w, scope('b1'))[0].policy, 'branch')

    const [again] = entriesOf(w, scope('b1'))

    assert.equal((await milestones.saveMilestone(w.repo, scope('b1'), { entry: again, t: 5000, type: 'battle', text: 'wide', policy: 'campaign' })).ok, true)
    assert.equal(entriesOf(w, scope('b2')).length, 1)
  })

  // ---- links --------------------------------------------------------------------------------------------------------

  const linked = async (w, where, type, row, extra = {}) => added(w, where, { link: link(type, row), ...extra })

  check('links', 'a link to each kind of object is linked while the object is as it was and is known to be the one that was linked, and the entry names it; a colony, which the save stores no date for, is never known', async () => {
    const w = make()
    const rows = { colony: colony(5, 'Earth', 3), system: system(3, 'Sol'), fleet: fleet(8, '1st Fleet', 40), ship: ship(12, 'Hood', 30) }

    for (const [type, row] of Object.entries(rows)) {
      await linked(w, scope(), type, row, { text: type })
    }

    const context = objectsOf(m, { colonies: [rows.colony], systems: [rows.system], fleets: [rows.fleet], ships: [rows.ship] })
    const entries = entriesOf(w, scope(), context)

    assert.equal(entries.length, 4)
    entries.forEach((entry) => {
      assert.equal(entry.link.type, entry.text)
      assert.equal(entry.link.name, rows[entry.text].name)
      assert.equal(entry.unresolved, false)

      if (entry.text === 'colony') {
        assertNotChecked(entry)
      } else {
        assert.equal(entry.link.status, 'linked', entry.text)
      }
    })
  })

  check('links', 'a deleted linked object leaves the milestone with an unresolved link: the note, its time and the link stay, and the entry says it is unresolved', async () => {
    const w = make()

    await linked(w, scope(), 'colony', colony(5, 'Earth'), { t: 777, text: 'Landing' })

    const [entry] = entriesOf(w, scope(), objectsOf(m, { colonies: [] }))

    assert.equal(entry.link.status, 'missing')
    assert.equal(entry.unresolved, true)
    assert.equal(entry.link.id, 5)
    assert.equal(entry.t, 777)
    assert.equal(entry.text, 'Landing')
    assert.ok(entry.flags.includes('missing-link'))
    assert.match(entry.link.reason, /Unresolved/)
  })

  check('links', 'a link is never rebound by name: another object with the same name or the same content under another ID leaves it missing', async () => {
    const w = make()

    await linked(w, scope(), 'colony', colony(5, 'Earth', 3))
    await linked(w, scope(), 'system', { id: 3, name: 'Sol' })
    await linked(w, scope(), 'event', { id: 'x', name: 'unused', time: 1, eventType: 1, copies: 1 })

    const lookalikes = objectsOf(m, { colonies: [colony(6, 'Earth', 3)], systems: [{ id: 4, name: 'Sol' }] })
    const entries = entriesOf(w, scope(), lookalikes)
    const byType = Object.fromEntries(entries.map((entry) => [entry.link.type, entry]))

    assert.equal(byType.colony.link.status, 'missing')
    assert.equal(byType.system.link.status, 'missing')
    assert.equal(byType.colony.link.id, 5)
    assert.equal(byType.system.link.id, 3)
    assert.equal(entriesOf(w, scope(), lookalikes).filter((entry) => entry.link.type !== 'event').every((entry) => entry.unresolved), true)
  })

  check('links', 'an ID that a save reuses for another object is changed, not linked, and the entry keeps the stored link', async () => {
    const w = make()

    await linked(w, scope(), 'colony', colony(5, 'Earth', 3))

    const [entry] = entriesOf(w, scope(), objectsOf(m, { colonies: [colony(5, 'Mars', 9)] }))

    assert.equal(entry.link.status, 'changed')
    assert.equal(entry.unresolved, true)
    assert.ok(entry.flags.includes('changed-link'))
    assert.equal(entry.link.id, 5)
    assert.match(entry.link.current, /^colony\|9\|/)
  })

  check('links', 'a link read with no save, or to a kind of object the save could not give, is unknown and never missing', async () => {
    const w = make()

    await linked(w, scope(), 'colony', colony(5, 'Earth'))
    await linked(w, scope(), 'ship', { id: 1, name: 'Hood' })

    const none = entriesOf(w, scope(), null)

    assert.deepEqual(none.map((entry) => entry.link.status), ['unknown', 'unknown'])

    const partial = objectsOf(m, { colonies: [colony(5, 'Earth')] })

    delete partial.objects.ship

    const entries = entriesOf(w, scope(), partial)
    const byType = Object.fromEntries(entries.map((entry) => [entry.link.type, entry]))

    assert.equal(byType.colony.link.status, 'unknown')
    assert.equal(byType.ship.link.status, 'unknown')
    assert.equal(byType.ship.unresolved, false)
    assert.deepEqual(entries.map((entry) => entry.link.status).filter((status) => status === 'missing'), [])
  })

  check('links', 'an edit keeps the link the milestone has, even a missing one, unless a link is given, and the link is never re-made from the objects of the save', async () => {
    const w = make()

    await linked(w, scope(), 'colony', colony(5, 'Earth'), { text: 'Landing' })

    const gone = objectsOf(m, { colonies: [] })
    const [entry] = entriesOf(w, scope(), gone)
    const edited = await milestones.saveMilestone(w.repo, scope(), { entry, t: 5000, type: 'battle', text: 'Landing, reworded' })

    assert.equal(edited.ok, true, edited.message)
    assert.equal(edited.record.links.length, 1)
    assert.equal(edited.record.links[0].id, 5)
    assert.equal(entriesOf(w, scope(), gone)[0].link.status, 'missing')
    assert.equal(entriesOf(w, scope(), gone)[0].link.name, 'Earth')
  })

  check('links', 'a link given in an edit replaces the old one, null removes it, and the new link names the object the player picked', async () => {
    const w = make()

    await linked(w, scope(), 'colony', colony(5, 'Earth'))

    const [entry] = entriesOf(w, scope(), objectsOf(m, { colonies: [colony(5, 'Earth'), colony(6, 'Mars')] }))
    const replaced = await milestones.saveMilestone(w.repo, scope(), { entry, t: 5000, type: 'battle', text: 'Battle of the pass', link: link('colony', colony(6, 'Mars')), context: contextOf(scope(), link('colony', colony(6, 'Mars'))) })

    assert.equal(replaced.ok, true, replaced.message)
    assert.deepEqual(replaced.record.links.map((stored) => stored.id), [6])

    const [second] = entriesOf(w, scope(), objectsOf(m, { colonies: [colony(6, 'Mars')] }))

    assert.equal(second.link.status, 'unknown')
    assert.equal(second.link.name, 'Mars')

    const cleared = await milestones.saveMilestone(w.repo, scope(), { entry: second, t: 5000, type: 'battle', text: 'Battle of the pass', link: null })

    assert.equal(cleared.ok, true, cleared.message)
    assert.equal(entriesOf(w, scope())[0].link, null)
    assert.deepEqual(cleared.record.links, [])
  })

  const logEvent = (rowid, IncrementID, Time, EventType, MessageText, place = {}) => ({ rowid, IncrementID, Time, EventType, MessageText, ...place })

  const saveOf = (events) => ({ colonies: [colony(5, 'Earth', 1, 50)], systems: [system(1, 'Sol')], fleets: [fleet(2, 'First Fleet')], ships: [ship(3, 'Hood')], events })

  check('links', 'a log event is named by its increment and its content: the key does not change with the row number and does with the content', () => {
    const base = { IncrementID: 40, Time: 1234, EventType: 7, MessageText: 'Ship lost', SystemID: 3, PopulationID: 0, Xcor: 1.5, Ycor: -2.5, IDType: 12 }

    assert.equal(milestones.eventKey(base), milestones.eventKey({ ...base, rowid: 99, RowID: 99 }))
    assert.equal(milestones.eventKey({ ...base, rowid: 1 }), milestones.eventKey({ ...base, rowid: 2 }))
    assert.notEqual(milestones.eventKey(base), milestones.eventKey({ ...base, MessageText: 'Ship lost!' }))
    assert.notEqual(milestones.eventKey(base), milestones.eventKey({ ...base, IncrementID: 41 }))
    assert.notEqual(milestones.eventKey(base), milestones.eventKey({ ...base, Time: 1235 }))
    assert.notEqual(milestones.eventKey(base), milestones.eventKey({ ...base, EventType: 8 }))
    assert.match(milestones.eventKey(base), /^40:[0-9a-f]{16}$/)
  })

  check('links', 'the key of a log event holds the place it names: the system, the colony, the coordinates and the kind of ID each change it', () => {
    const base = { IncrementID: 40, Time: 1234, EventType: 7, MessageText: 'Ship lost', SystemID: 3, PopulationID: 0, Xcor: 1.5, Ycor: -2.5, IDType: 12 }

    for (const change of [{ SystemID: 4 }, { PopulationID: 9 }, { Xcor: 1.6 }, { Ycor: -2.6 }, { IDType: 13 }, { SystemID: null }]) {
      assert.notEqual(milestones.eventKey(base), milestones.eventKey({ ...base, ...change }), JSON.stringify(change))
    }

    assert.equal(milestones.eventKey(base), milestones.eventKey({ ...base, rowid: 5, RowID: 5, RowNumber: 5 }))
  })

  check('links', 'no query the utility sends names the rowid, and the objects it builds carry no row number', async () => {
    const database = fakeSave(saveOf([logEvent(1, 10, 100, 5, 'a'), logEvent(2, 10, 100, 5, 'b')]))
    const { objects, failed } = await milestones.loadObjects(database, { GameID: 1, RaceID: 7, increments: [10] })

    assert.deepEqual(failed, {})
    assert.ok(database.sent.length >= 6)
    database.sent.forEach((sql) => assert.doesNotMatch(sql, /rowid/i, sql))
    database.sent.filter((sql) => sql.includes('from FCT_GameLog')).forEach((sql) => ['SystemID', 'PopulationID', 'Xcor', 'Ycor', 'IDType'].forEach((column) => assert.match(sql, new RegExp(`FCT_GameLog\\.${column}\\b`), `${column} in ${sql}`)))
    assert.deepEqual(Object.keys(objects).sort(), ['colony', 'event', 'fleet', 'ship', 'system'])

    for (const event of objects.event.values()) {
      assert.deepEqual(Object.keys(event).sort(), ['copies', 'eventType', 'id', 'idType', 'incrementId', 'name', 'populationId', 'systemId', 'time', 'type', 'xcor', 'ycor'])
      assert.doesNotMatch(String(event.id), /^\d+$/)
    }
  })

  check('links', 'a link to an event made in one save resolves in another whose rows were all renumbered, and not when the event says something else', async () => {
    const w = make()
    const first = fakeSave(saveOf([logEvent(1, 10, 100, 5, 'Battle at Sol'), logEvent(2, 10, 100, 5, 'Fleet arrived'), logEvent(3, 11, 200, 6, 'Colony founded')]))
    const objectsFirst = await milestones.loadObjects(first, { GameID: 1, RaceID: 7 })
    const choices = milestones.linkChoices(objectsFirst.objects, 'event')

    assert.deepEqual(choices.map((choice) => choice.name), ['Colony founded', 'Battle at Sol', 'Fleet arrived'])

    const battle = choices.find((choice) => choice.name === 'Battle at Sol')

    await added(w, scope(), { t: battle.row.time, link: { type: 'event', row: battle.row }, text: 'Battle at Sol' })

    const renumbered = fakeSave(saveOf([logEvent(901, 11, 200, 6, 'Colony founded'), logEvent(902, 10, 100, 5, 'Fleet arrived'), logEvent(903, 10, 100, 5, 'Battle at Sol')]))
    const [read] = [await milestones.loadObjects(renumbered, { GameID: 1, RaceID: 7, increments: milestones.incrementsOf(entriesOf(w, scope())) })]
    const [entry] = entriesOf(w, scope(), { objects: read.objects })

    assert.equal(entry.link.status, 'linked')
    assert.equal(entry.t, 100)

    const reworded = fakeSave(saveOf([logEvent(1, 10, 100, 5, 'Battle at Sol (reported again)')]))
    const other = await milestones.loadObjects(reworded, { GameID: 1, RaceID: 7, increments: [10] })

    assert.equal(entriesOf(w, scope(), { objects: other.objects })[0].link.status, 'missing')
  })

  check('links', 'a row the log holds twice is one event that counts its copies: the link changes when the count does and is never bound to one copy by its row number', async () => {
    const w = make()
    const twice = fakeSave(saveOf([logEvent(1, 10, 100, 5, 'Same words'), logEvent(2, 10, 100, 5, 'Same words')]))
    const objects = await milestones.loadObjects(twice, { GameID: 1, RaceID: 7 })

    assert.equal(objects.objects.event.size, 1)

    const [pick] = milestones.linkChoices(objects.objects, 'event')

    assert.equal(pick.row.copies, 2)
    await added(w, scope(), { link: { type: 'event', row: pick.row } })

    const still = await milestones.loadObjects(fakeSave(saveOf([logEvent(7, 10, 100, 5, 'Same words'), logEvent(8, 10, 100, 5, 'Same words')])), { GameID: 1, RaceID: 7, increments: [10] })

    assert.equal(entriesOf(w, scope(), { objects: still.objects })[0].link.status, 'ambiguous')

    const fewer = await milestones.loadObjects(fakeSave(saveOf([logEvent(7, 10, 100, 5, 'Same words')])), { GameID: 1, RaceID: 7, increments: [10] })

    assert.equal(entriesOf(w, scope(), { objects: fewer.objects })[0].link.status, 'changed')
  })

  check('links', 'a kind of object the save cannot give is named as failed and the others still load', async () => {
    const database = fakeSave(saveOf([logEvent(1, 10, 100, 5, 'a')]), { failing: ['FCT_Fleet'] })
    const { objects, failed } = await milestones.loadObjects(database, { GameID: 1, RaceID: 7 })

    assert.deepEqual(Object.keys(failed), ['fleet'])
    assert.match(failed.fleet, /FCT_Fleet/)
    assert.equal(objects.fleet, undefined)
    assert.equal(objects.colony.size, 1)
    assert.equal(objects.event.size, 1)
  })

  check('links', 'the objects a milestone can link to are listed by name, events newest first', async () => {
    const database = fakeSave({ ...saveOf([logEvent(1, 10, 100, 5, 'old'), logEvent(2, 12, 300, 5, 'new'), logEvent(3, 11, 200, 5, 'middle')]), ships: [{ id: 2, name: 'Zulu' }, { id: 1, name: 'Alpha' }] })
    const { objects } = await milestones.loadObjects(database, { GameID: 1, RaceID: 7 })

    assert.deepEqual(milestones.linkChoices(objects, 'ship').map((choice) => choice.name), ['Alpha', 'Zulu'])
    assert.deepEqual(milestones.linkChoices(objects, 'event').map((choice) => choice.name), ['new', 'middle', 'old'])
    assert.deepEqual(milestones.linkChoices(null, 'ship'), [])
    assert.deepEqual(milestones.incrementsOf([{ links: [{ type: 'event', id: '12:abcd0123' }, { type: 'event', id: '10:00000000' }, { type: 'colony', id: 5 }, { type: 'event', id: '12:ffffffff' }] }]), [10, 12])
  })

  check('links', 'a log event the log holds several times over is ambiguous in the picker and in the link, and still counts as resolved when the copies are as many as they were', async () => {
    const w = make()
    const objects = await milestones.loadObjects(fakeSave(saveOf([logEvent(1, 10, 100, 5, 'Same words'), logEvent(2, 10, 100, 5, 'Same words'), logEvent(3, 11, 200, 5, 'Said once')])), { GameID: 1, RaceID: 7 })
    const picks = milestones.linkChoices(objects.objects, 'event')

    assert.deepEqual(picks.map((pick) => [pick.name, pick.ambiguous]), [['Said once', false], ['Same words', true]])
    await added(w, scope(), { link: { type: 'event', row: picks[1].row }, text: 'twice' })
    await added(w, scope(), { link: { type: 'event', row: picks[0].row }, text: 'once' })

    const entries = entriesOf(w, scope(), objects)
    const byText = Object.fromEntries(entries.map((entry) => [entry.text, entry]))

    assert.equal(byText.twice.link.status, 'ambiguous')
    assert.equal(byText.twice.link.copies, 2)
    assert.ok(byText.twice.flags.includes('ambiguous-link'))
    assert.match(byText.twice.link.reason, /more than once/)
    assert.equal(byText.once.link.status, 'linked')
    assert.equal(byText.once.link.copies, 1)
  })

  check('links', 'two rows of the log that say the same in two places are two events, and a swap of one for the other is not linked', async () => {
    const w = make()
    const place = (SystemID) => ({ SystemID, PopulationID: 0, Xcor: SystemID * 10, Ycor: 5, IDType: 1 })
    const first = await milestones.loadObjects(fakeSave(saveOf([logEvent(1, 10, 100, 5, 'Hostile contact', place(1)), logEvent(2, 10, 100, 5, 'Hostile contact', place(2))])), { GameID: 1, RaceID: 7 })

    assert.equal(first.objects.event.size, 2)
    assert.deepEqual(milestones.linkChoices(first.objects, 'event').map((pick) => pick.ambiguous), [false, false])

    const atOne = milestones.linkChoices(first.objects, 'event').find((pick) => pick.row.systemId === 1)

    await added(w, scope(), { link: { type: 'event', row: atOne.row }, context: contextFor(first) })

    const swapped = contextFor(await milestones.loadObjects(fakeSave(saveOf([logEvent(1, 10, 100, 5, 'Hostile contact', place(2))])), { GameID: 1, RaceID: 7, increments: [10] }))

    assert.equal(entriesOf(w, scope(), swapped)[0].link.status, 'missing')

    const renumbered = contextFor(await milestones.loadObjects(fakeSave(saveOf([logEvent(9, 10, 100, 5, 'Hostile contact', place(2)), logEvent(8, 10, 100, 5, 'Hostile contact', place(1))])), { GameID: 1, RaceID: 7, increments: [10] }))

    assert.equal(entriesOf(w, scope(), renumbered)[0].link.status, 'linked')
  })

  const plural = { colony: 'colonies', system: 'systems', fleet: 'fleets', ship: 'ships' }
  const renames = {
    system: { was: system(3, 'Sol', 7, 1, 500), renamed: system(3, 'Home', 7, 1, 500), another: system(3, 'Home', 7, 2, 500) },
    fleet: { was: fleet(8, '1st Fleet', 700), renamed: fleet(8, 'Grand Fleet', 700), another: fleet(8, 'Grand Fleet', 900) },
    ship: { was: ship(12, 'Hood', 500), renamed: ship(12, 'Warspite', 500), another: ship(12, 'Warspite', 900) },
  }

  for (const type of Object.keys(renames)) {
    check('links', `a renamed ${type} stays linked: the name is for display, the new name is shown beside the one kept, and another object that takes the old name is not bound`, async () => {
      const w = make()
      const { was, renamed, another } = renames[type]

      await linked(w, scope(), type, was, { text: 'about it' })

      const lookalike = { ...was, id: was.id + 1000 }
      const [entry] = entriesOf(w, scope(), objectsOf(m, { [plural[type]]: [renamed, lookalike] }))

      assert.equal(entry.link.status, 'linked')
      assert.equal(entry.link.id, was.id)
      assert.equal(entry.link.name, was.name)
      assert.equal(entry.link.nowNamed, renamed.name)
      assert.equal(entry.unresolved, false)
      assert.equal(entry.flags.includes('changed-link'), false)
      assert.equal(entriesOf(w, scope(), objectsOf(m, { [plural[type]]: [was] }))[0].link.nowNamed, null)

      if (another) {
        assert.equal(entriesOf(w, scope(), objectsOf(m, { [plural[type]]: [another] }))[0].link.status, 'changed', 'a field the game does not change on a rename did change')
      }

      assert.equal(entriesOf(w, scope(), objectsOf(m, { [plural[type]]: [lookalike] }))[0].link.status, 'missing')
    })
  }

  // ---- an ID the game may have given again to another object ----------------------------------------------------------

  const assertNotChecked = (entry) => {
    assert.equal(entry.link.status, 'unknown')
    assert.equal(entry.link.unverified, true)
    assert.equal(entry.link.nowNamed, null)
    assert.match(entry.link.reason, /^Not checked: /)
    assert.equal(entry.unresolved, false, 'an object that is not known to be the same one is not an unresolved link')
    assert.ok(entry.flags.includes('unverified-link'))
  }

  check('links', 'a colony is never linked: the save stores no date for it and one body holds several, so an ID given again to another colony on the same body cannot be told, and only another system, body or species shows it changed', async () => {
    const w = make()

    await linked(w, scope('b1'), 'colony', colony(5, 'Earth', 3, 31, 7), { text: 'landing' })

    const read = (branchId, colonies) => entriesOf(w, scope(branchId), objectsOf(m, { colonies, branchId }))[0]

    for (const branchId of ['b1', 'b2', 'b3']) {
      assertNotChecked(read(branchId, [colony(5, 'Earth', 3, 31, 7)]))
      assertNotChecked(read(branchId, [colony(5, 'Terra', 3, 31, 7)]))
      assert.match(read(branchId, [colony(5, 'Earth', 3, 31, 7)]).link.reason, /the save stores no date for a colony/)

      for (const reissued of [colony(5, 'Alien colony', 3, 31, 8), colony(5, 'Earth', 3, 32, 7), colony(5, 'Earth', 4, 31, 7), colony(5, 'Earth', 3, 31, null)]) {
        const entry = read(branchId, [reissued])

        assert.equal(entry.link.status, 'changed', `${reissued.name} ${reissued.bodyId} ${reissued.speciesId} on ${branchId}`)
        assert.equal(entry.unresolved, true)
      }

      assert.equal(read(branchId, []).link.status, 'missing')
      assert.equal(read(branchId, [colony(6, 'Earth', 3, 31, 7)]).link.status, 'missing')
    }
  })

  check('links', 'a fleet is the same one only with the creation time it was linked with: an ID given again to another fleet is changed on the branch it was made on, and on another branch the fleet must also have been created before the two branches parted', async () => {
    const w = make()

    await linked(w, scope('b1'), 'fleet', fleet(8, '1st Fleet', 500), { text: 'early fleet' })
    await linked(w, scope('b1'), 'fleet', fleet(9, '2nd Fleet', 1500), { text: 'late fleet' })
    await linked(w, scope('b1'), 'fleet', fleet(10, '3rd Fleet', null), { text: 'untimed fleet' })

    const rows = [fleet(8, 'Grand Fleet', 500), fleet(9, '2nd Fleet', 1500), fleet(10, '3rd Fleet', null)]
    const status = (branchId, fleets, text) => entriesOf(w, scope(branchId), objectsOf(m, { fleets, branchId })).find((entry) => entry.text === text)
    const same = status('b1', rows, 'early fleet')

    assert.equal(same.link.status, 'linked')
    assert.equal(same.link.unverified, false)
    assert.equal(same.link.nowNamed, 'Grand Fleet')
    assert.equal(same.flags.includes('unverified-link'), false)
    assert.equal(status('b1', rows, 'late fleet').link.status, 'linked')
    assert.equal(status('b1', [fleet(8, 'Reissued', 4000), ...rows.slice(1)], 'early fleet').link.status, 'changed', 'the ID went to a fleet created later, without a rewind')

    const pruned = status('b1', [fleet(8, 'Grand Fleet', null), ...rows.slice(1)], 'early fleet')

    assertNotChecked(pruned)
    assert.match(pruned.link.reason, /does not give the time/)
    assert.equal(pruned.flags.includes('changed-link'), false, 'a creation entry that the save no longer holds is not another fleet')

    const untimed = status('b1', rows, 'untimed fleet')

    assertNotChecked(untimed)
    assert.match(untimed.link.reason, /does not give the time/)
    assert.equal(status('b2', rows, 'early fleet').link.status, 'linked')
    assert.equal(status('b2', rows, 'early fleet').link.unverified, false)

    const parted = status('b2', rows, 'late fleet')

    assertNotChecked(parted)
    assert.match(parted.link.reason, /made before the link's branch and this one parted/)
    assert.equal(parted.link.id, 9)
    assert.equal(parted.link.name, '2nd Fleet', 'the link keeps what it was made with')
    assertNotChecked(status('b2', rows, 'untimed fleet'))
    assert.equal(status('b2', [], 'early fleet').link.status, 'missing')
    assert.equal(status('b2', [fleet(11, '1st Fleet', 500)], 'early fleet').link.status, 'missing')
    assert.equal(status('b2', [fleet(8, 'Another', 1200)], 'early fleet').link.status, 'changed')

    const there = await added(w, scope('b2'), { text: 'made on b2', link: link('fleet', fleet(8, 'Something else', 1200)) })

    assert.deepEqual(there.payload.link.origin, { campaignId: 'c1', branchId: 'b2' })
    assert.equal(status('b2', [fleet(8, 'Something else', 1200)], 'made on b2').link.status, 'linked')

    await added(w, scope('b1'), { text: 'made at the parting', link: link('fleet', fleet(12, 'Edge', 1000)) })

    assertNotChecked(status('b2', [fleet(12, 'Edge', 1000)], 'made at the parting'))
    assert.equal(status('b1', [fleet(12, 'Edge', 1000)], 'made at the parting').link.status, 'linked')
    assertNotChecked(status('b1', [fleet(8, 'Something else', 1200)], 'made on b2'))
  })

  check('links', 'a ship is the same one only with the construction time it was linked with: an ID given again is changed, a ship with no time is not told, and on another branch the ship must also have been built before the two branches parted', async () => {
    const w = make()

    await linked(w, scope('b1'), 'ship', ship(12, 'Hood', 500), { text: 'built early' })
    await linked(w, scope('b1'), 'ship', ship(13, 'Rodney', 1500), { text: 'built late' })
    await linked(w, scope('b1'), 'ship', ship(14, 'Nelson', null), { text: 'no time' })
    await linked(w, scope('b1'), 'ship', ship(15, 'Anson', 1000), { text: 'built at the parting' })

    const status = (branchId, rows, text) => entriesOf(w, scope(branchId), objectsOf(m, { ships: rows, branchId })).find((entry) => entry.text === text)
    const rows = [ship(12, 'Hood', 500), ship(13, 'Rodney', 1500), ship(14, 'Nelson', null)]

    assert.deepEqual(['built early', 'built late'].map((text) => status('b1', rows, text).link.status), ['linked', 'linked'])
    assert.equal(status('b1', [ship(12, 'Hood', 900), ship(13, 'Rodney', 1500)], 'built early').link.status, 'changed', 'the ID went to a ship built later, without a rewind')
    assertNotChecked(status('b1', rows, 'no time'))
    assert.equal(status('b2', rows, 'built early').link.status, 'linked')
    assert.equal(status('b2', rows, 'built early').link.unverified, false)
    assertNotChecked(status('b2', rows, 'built late'))
    assertNotChecked(status('b2', rows, 'no time'))
    assert.equal(status('b2', [ship(12, 'Hood', 900), ship(13, 'Rodney', 1500)], 'built early').link.status, 'changed', 'another time is another ship')
    assert.equal(status('b2', [ship(13, 'Rodney', 1500)], 'built early').link.status, 'missing')
    assert.equal(status('b3', rows, 'built late').link.status, 'linked', 'b3 left b1 at 3000, after the ship was built at 1500')
    assertNotChecked(status('b4', rows, 'built early'))
    assertNotChecked(status('b2', [...rows, ship(15, 'Anson', 1000)], 'built at the parting'))
    assert.equal(status('b1', [...rows, ship(15, 'Anson', 1000)], 'built at the parting').link.status, 'linked', 'on its own branch the time is no limit')
    assert.equal(status('b3', [...rows, ship(15, 'Anson', 1000)], 'built at the parting').link.status, 'linked', 'b3 left b1 at 3000')
    assertNotChecked(status('b4', rows, 'built late'))
  })

  check('links', 'a system on another branch is the same one only where it was discovered before the branches parted, and a colony on none', async () => {
    const w = make()

    await linked(w, scope('b1'), 'system', system(3, 'Sol', 7, 1, 500), { text: 'found early' })
    await linked(w, scope('b1'), 'system', system(4, 'Vega', 8, 1, 2000), { text: 'found late' })
    await linked(w, scope('b1'), 'colony', colony(5, 'Earth', 3, 31), { text: 'kept place' })
    await linked(w, scope('b1'), 'colony', colony(6, 'Mars', 3, null), { text: 'no body' })

    const rows = { systems: [system(3, 'Sol', 7, 1, 500), system(4, 'Vega', 8, 1, 2000)], colonies: [colony(5, 'Earth', 3, 31), colony(6, 'Mars', 3, null)] }
    const status = (branchId, text) => entriesOf(w, scope(branchId), objectsOf(m, { ...rows, branchId })).find((entry) => entry.text === text)

    for (const text of ['found early', 'found late']) {
      assert.equal(status('b1', text).link.status, 'linked', text)
    }

    assertNotChecked(status('b1', 'kept place'))
    assertNotChecked(status('b1', 'no body'))

    assert.equal(status('b2', 'found early').link.status, 'linked')
    assertNotChecked(status('b2', 'found late'))
    assertNotChecked(status('b2', 'kept place'))
    assertNotChecked(status('b2', 'no body'))
  })

  check('links', 'the game time two branches share is the least of the times each left the branch it came from, and nothing is certified when the registry does not say it', async () => {
    const w = make()

    await linked(w, scope('b3'), 'ship', ship(12, 'Hood', 2000), { text: 'built on b3 at 2000' })
    await linked(w, scope('b1'), 'ship', ship(13, 'Rodney', 400), { text: 'built at 400' })

    const read = (branchId, rows, text, branches = TREE) => entriesOf(w, scope(branchId), objectsOf(m, { ships: rows, branchId, branches })).find((entry) => entry.text === text)
    const rows = [ship(12, 'Hood', 2000), ship(13, 'Rodney', 400)]

    assertNotChecked(read('b2', rows, 'built on b3 at 2000'))
    assert.equal(read('b1', rows, 'built on b3 at 2000').link.status, 'linked', 'b3 left b1 at 3000, so b1 holds what b3 held up to then')
    assert.equal(read('b4', rows, 'built at 400').link.status, 'linked', 'b4 left b2 at 500, b2 left b1 at 1000: 400 is before both')
    assert.equal(read('b2', rows, 'built at 400').link.status, 'linked')

    const noTimes = { b1: { parent: null, t: null }, b2: { parent: 'b1', t: null }, b3: { parent: 'b1', t: 3000 } }

    assertNotChecked(read('b2', rows, 'built at 400', noTimes))
    assertNotChecked(read('b2', rows, 'built at 400', null))
    assertNotChecked(read('b2', rows, 'built at 400', { b1: { parent: null, t: null } }))
    assertNotChecked(read('b2', rows, 'built at 400', { b2: { parent: 'zz', t: 1000 } }))
    assertNotChecked(read('b2', rows, 'built at 400', {}))
    assert.equal(read('b1', rows, 'built at 400', null).link.status, 'linked', 'on its own branch the lineage is not needed')
  })

  check('links', 'a link made in another campaign is told from this save only by what belongs to the object, never by an ID or a time that means nothing here', async () => {
    const w = attachedWorld(MODES.same)
    const there = scope('b1', 100000, 's1')

    await milestones.saveMilestone(w.repo, there, { t: 1, type: 'other', text: 'fleet', link: link('fleet', fleet(8, '1st Fleet', 0)), context: contextOf(there, link('fleet', fleet(8, '1st Fleet', 0))) })
    await milestones.saveMilestone(w.repo, there, { t: 2, type: 'other', text: 'ship', link: link('ship', ship(12, 'Hood', 0)), context: contextOf(there, link('ship', ship(12, 'Hood', 0))) })
    await milestones.saveMilestone(w.repo, there, { t: 3, type: 'other', text: 'colony', link: link('colony', colony(5, 'Earth', 3, 31)), context: contextOf(there, link('colony', colony(5, 'Earth', 3, 31))) })

    const read = milestones.readAttachedMilestones(w.repo, scope('b1'), objectsOf(m, { fleets: [fleet(8, '1st Fleet')], ships: [ship(12, 'Hood', 0)], colonies: [colony(5, 'Earth', 3, 31)] }), ['b1']).entries
    const byText = Object.fromEntries(read.map((entry) => [entry.text, entry]))

    assertNotChecked(byText.fleet)
    assertNotChecked(byText.ship)
    assertNotChecked(byText.colony)
    assert.deepEqual(byText.fleet.link.origin, { campaignId: 's1', branchId: 'b1' })
  })

  check('links', 'the lineage of a campaign is read from its registry entry: the branch each one left and the time it left it at, with no time where none was recorded', () => {
    const entry = { branches: { b1: { id: 'b1', parent: null, fork: null }, b2: { id: 'b2', parent: 'b1', fork: { n: 3, digest: 'x', t: 1000 } }, b3: { id: 'b3', parent: 'b1', fork: { n: 3, digest: 'x', t: 'late' } }, b4: 'garbage' } }

    assert.deepEqual(milestones.branchLineage(entry), { b1: { parent: null, t: null }, b2: { parent: 'b1', t: 1000 }, b3: { parent: 'b1', t: null } })
    assert.deepEqual(milestones.branchLineage(null), {})
    assert.deepEqual(milestones.branchLineage({ branches: 4 }), {})

    const context = { campaignId: 'c1', branchId: 'b2', branches: TREE }

    assert.equal(milestones.sharedHistory(context, { campaignId: 'c1', branchId: 'b2' }), Infinity)
    assert.equal(milestones.sharedHistory(context, { campaignId: 'c1', branchId: 'b1' }), 1000)
    assert.equal(milestones.sharedHistory(context, { campaignId: 'c1', branchId: 'b3' }), 1000)
    assert.equal(milestones.sharedHistory({ ...context, branchId: 'b4' }, { campaignId: 'c1', branchId: 'b3' }), 500)
    assert.equal(milestones.sharedHistory(context, { campaignId: 'c2', branchId: 'b2' }), null)
    assert.equal(milestones.sharedHistory(context, null), null)
    assert.equal(milestones.sharedHistory(null, { campaignId: 'c1', branchId: 'b2' }), null)
    assert.equal(milestones.sharedHistory({ ...context, branches: null }, { campaignId: 'c1', branchId: 'b1' }), null)
    assert.equal(milestones.sharedHistory(context, { campaignId: 'c1', branchId: 'zz' }), null)
  })

  check('links', 'a link keeps the campaign and branch it was made on, a record without them is a note that cannot be read, and a link is refused against the objects of another campaign or branch', async () => {
    const w = make()
    const record = await linked(w, scope('b2'), 'fleet', fleet(8, '1st Fleet'), { text: 'about it' })

    assert.deepEqual(record.payload.link.origin, { campaignId: 'c1', branchId: 'b2' })

    const [entry] = entriesOf(w, scope('b2'), objectsOf(m, { fleets: [fleet(8, '1st Fleet')], branchId: 'b2' }))
    const edited = await milestones.saveMilestone(w.repo, scope('b2'), { entry, t: 5000, type: 'battle', text: 'reworded' })

    assert.deepEqual(edited.record.payload.link.origin, { campaignId: 'c1', branchId: 'b2' }, 'an edit keeps the origin of the link it keeps')

    const other = make()

    assert.equal((await other.add(scope('b2'), { link: link('fleet', fleet(8, 'x')), context: objectsOf(m, { fleets: [fleet(8, 'x')], branchId: 'b1' }) })).code, 'link-out-of-scope')
    assert.equal((await other.add(scope('b2'), { link: link('fleet', fleet(8, 'x')), context: objectsOf(m, { fleets: [fleet(8, 'x')], branchId: 'b2', campaignId: 'c9' }) })).code, 'link-out-of-scope')

    const bare = await milestones.saveMilestone(other.repo, scope('b2'), { t: 1, type: 'other', text: 'x' })
    const stored = JSON.parse(JSON.stringify(other.inst.files.get('campaign-c1')))

    assert.equal(bare.ok, true)
    Object.values(stored.records).forEach((one) => { one.payload.link = { type: 'fleet', id: 8, name: 'x' } })
    other.inst.files.set('campaign-c1', stored)

    const read = milestones.readMilestones(other.repo, scope('b2'), objectsOf(m, { fleets: [fleet(8, 'x')], branchId: 'b2' }))

    assert.equal(read.entries.length, 0)
    assert.equal(read.notes.length, 1)
    assert.match(JSON.stringify(read.notes[0]), /invalid-payload|origin/)
  })

  check('links', 'every event a milestone links to is read, however many: more than one batch of increments, none left out, and a batch that fails leaves the links unknown, never missing', async () => {
    const count = 520
    const w = make()
    const events = Array.from({ length: count }, (_, index) => logEvent(index + 1, index + 1, 1000 + index, 5, `Event ${index + 1}`))
    const earlier = await milestones.loadObjects(fakeSave(saveOf(events)), { GameID: 1, RaceID: 7, increments: events.map((event) => event.IncrementID) })

    assert.equal(earlier.objects.event.size, count)

    for (const pick of milestones.linkChoices(earlier.objects, 'event')) {
      await added(w, scope(), { t: pick.row.time, text: pick.name, link: { type: 'event', row: pick.row }, context: contextFor(earlier) })
    }

    const wanted = milestones.incrementsOf(entriesOf(w, scope()))

    assert.equal(wanted.length, count)
    assert.deepEqual([wanted[0], wanted[count - 1]], [1, count])

    const later = fakeSave(saveOf(events.map((event, index) => ({ ...event, rowid: 9000 + index }))))
    const read = await milestones.loadObjects(later, { GameID: 1, RaceID: 7, increments: wanted })
    const batches = later.sent.filter((sql) => /IncrementID in \(\d/.test(sql)).map((sql) => /in \(([\d, ]+)\)$/.exec(sql)[1].split(',').length)

    assert.deepEqual(read.failed, {})
    assert.ok(batches.length >= 2, `${batches.length} batches`)
    assert.ok(batches.every((size) => size <= milestones.INCREMENTS_PER_READ))
    assert.equal(batches.reduce((sum, size) => sum + size, 0), count)
    assert.deepEqual([...new Set(entriesOf(w, scope(), read).map((entry) => entry.link.status))], ['linked'])

    let calls = 0
    const flaky = { query: async (sql, options) => { if (/IncrementID in \(\d/.test(sql) && ++calls === 2) { throw new Error('database is locked') } return later.query(sql, options) } }
    const broken = await milestones.loadObjects(flaky, { GameID: 1, RaceID: 7, increments: wanted })

    assert.match(broken.failed.event, /locked/)
    assert.deepEqual([...new Set(entriesOf(w, scope(), broken).map((entry) => entry.link.status))], ['unknown'])
  })

  // ---- scope --------------------------------------------------------------------------------------------------------

  check('scope', 'a link is made only against the objects of the race it is kept for, and only for an object that is there as it was picked', async () => {
    const w = make()
    const pick = link('colony', colony(5, 'Earth', 3, 31))
    const own = contextOf(scope(), pick)
    const refused = [[null, 'link-out-of-scope'], [{ ...own, RaceID: 8 }, 'link-out-of-scope'], [{ ...own, campaignId: 'c2' }, 'link-out-of-scope'], [{ ...own, branchId: 'b2' }, 'link-out-of-scope'], [{ RaceID: 7 }, 'link-out-of-scope'], [{ ...own, objects: {} }, 'link-not-read'], [{ ...own, objects: { colony: new Map() } }, 'link-stale'], [contextOf(scope(), link('colony', colony(5, 'Earth', 3, 99))), 'link-stale']]

    for (const [context, code] of refused) {
      const outcome = await w.add(scope(), { link: pick, context })

      assert.equal(outcome.ok, false)
      assert.equal(outcome.code, code)
    }

    assert.equal((await w.add(scope('b1', 100000, 'c1', 8), { link: pick, context: own })).code, 'link-out-of-scope')
    assert.equal(w.inst.files.has('campaign-c1'), false)
    assert.equal((await w.add(scope(), { link: pick, context: own })).ok, true)
  })

  check('scope', 'the link keeps the name the object has in the save now when it was renamed since it was picked, and an edit that gives no link needs no objects', async () => {
    const w = make()
    const picked = link('colony', colony(5, 'Earth', 3, 31))
    const now = contextOf(scope(), link('colony', colony(5, 'Terra', 3, 31)))
    const record = await added(w, scope(), { link: picked, context: now })

    assert.equal(record.payload.link.name, 'Terra')

    const [entry] = entriesOf(w, scope(), now)
    const edited = await milestones.saveMilestone(w.repo, scope(), { entry, t: 5000, type: 'battle', text: 'reworded' })

    assert.equal(edited.ok, true, edited.message)
    assert.equal(edited.record.payload.link.name, 'Terra')
  })

  // ---- attached -----------------------------------------------------------------------------------------------------

  const MODES = { same: { campaignId: 'c1', branchId: 'b1', at: 5 }, 'new-branch': { campaignId: 'c1', branchId: 'b2', at: 5 } }

  const attachedWorld = (mergedInto) => {
    const w = make()

    w.inst.registry.value = { campaigns: { c1: campaignEntry('c1'), s1: campaignEntry('s1', mergedInto) } }

    return w
  }

  for (const [mode, mergedInto] of Object.entries(MODES)) {
    check('attached', `after an attach in the mode ${mode} the milestones of the attached campaign are listed apart, never drawn, never merged by a read, and adopted only on request, once`, async () => {
      const w = attachedWorld(mergedInto)
      const earth = colony(5, 'Earth', 3, 31)
      const there = scope('b1', 100000, 's1')

      await milestones.saveMilestone(w.repo, there, { t: 4000, type: 'colonisation', text: 'Landing', link: link('colony', earth), context: contextOf(there, link('colony', earth)) })
      await milestones.saveMilestone(w.repo, there, { t: 9000, type: 'battle', text: 'A fight' })

      const where = scope(mergedInto.branchId, 100000, 'c1')
      const context = objectsOf(m, { colonies: [earth] })

      assert.deepEqual(entriesOf(w, where, context), [])
      assert.deepEqual(milestones.markersOf(entriesOf(w, where, context), snapshotsAt([0, 200000]), position), [])

      const attached = milestones.readAttachedMilestones(w.repo, where, context, [])

      assert.equal(attached.error, null)
      assert.deepEqual(attached.refused, [])
      assert.deepEqual(attached.entries.map((entry) => [entry.text, entry.attachedFrom, entry.adopted, entry.flags.includes('attached-campaign')]), [['Landing', 's1', false, true], ['A fight', 's1', false, true]])
      assert.equal(attached.entries[0].link.status, 'unknown')
      assert.equal(w.inst.files.has('campaign-c1'), false, 'listing wrote nothing into the campaign')

      const source = JSON.stringify(w.inst.files.get('campaign-s1'))
      const adopted = await milestones.adoptMilestone(w.repo, where, attached.entries[0])

      assert.equal(adopted.ok, true, adopted.message)
      assert.equal(adopted.record.provenance.via, 'adopt')
      assert.notEqual(adopted.record.uuid, attached.entries[0].uuid)

      const own = entriesOf(w, where, context)

      assert.deepEqual(own.map((entry) => [entry.text, entry.t, entry.link.status]), [['Landing', 4000, 'unknown']])
      assert.deepEqual(own[0].adoptedFrom, { campaignId: 's1', uuid: attached.entries[0].uuid })
      assert.deepEqual(milestones.readAttachedMilestones(w.repo, where, context, ['b1', 'b2']).entries.map((entry) => entry.adopted), [true, false])
      assert.equal((await milestones.adoptMilestone(w.repo, where, attached.entries[0])).code, 'collision')
      assert.equal(entriesOf(w, where, context).length, 1)
      assert.equal(JSON.stringify(w.inst.files.get('campaign-s1')), source, 'the attached campaign keeps its own')
      assert.equal(entriesOf(w, scope('b1', 100000, 's1'), context).length, 2)
    })
  }

  for (const policy of ['branch', 'campaign']) {
    check('attached', `a milestone adopted onto one branch reads as adopted on every other branch of the campaign, with the branch that holds the copy, and is not offered again (copy kept for the ${policy})`, async () => {
      const w = attachedWorld(MODES.same)
      const there = scope('b1', 100000, 's1')

      await milestones.saveMilestone(w.repo, there, { t: 4000, type: 'other', text: 'Landing', policy })

      const where = (branchId) => scope(branchId, 100000, 'c1')
      const read = (branchId, branchIds = ['b1', 'b2']) => milestones.readAttachedMilestones(w.repo, where(branchId), objectsOf(m, { branchId }), branchIds).entries[0]

      assert.equal(read('b1').adopted, false)
      assert.equal(read('b1').adoptedOn, null)

      const adopted = await milestones.adoptMilestone(w.repo, where('b2'), read('b2'))

      assert.equal(adopted.ok, true, adopted.message)

      const onB2 = read('b2')
      const onB1 = read('b1')

      assert.equal(onB2.adopted, true)
      assert.equal(onB1.adopted, true, 'the shown branch is not the one that holds the copy')
      assert.deepEqual(onB1.adoptedOn, onB2.adoptedOn)
      assert.equal(onB1.adoptedOn.uuid, adopted.record.uuid)
      assert.equal(onB1.adoptedOn.branchId, 'b2')
      assert.equal(onB1.adoptedOn.policy, policy)
      assert.equal((await milestones.adoptMilestone(w.repo, where('b1'), onB1)).code, 'collision', 'the repository refuses it wherever the copy is kept, so it is not offered')
      assert.equal(read('b1', []).adopted, policy === 'campaign', 'with no branches read, only what the shown branch lists is known')

      const stored = JSON.parse(JSON.stringify(w.inst.files.get('campaign-c1')))

      Object.keys(stored.records).filter((key) => stored.records[key].provenance && stored.records[key].provenance.via === 'adopt').forEach((key) => delete stored.records[key])
      w.inst.files.set('campaign-c1', stored)
      assert.equal(read('b1').adopted, false, 'a copy that was deleted can be adopted again')
    })
  }

  check('attached', 'a source file that cannot be read is named and does not hide the others, a registry that cannot be read is an error, and nothing attached means nothing listed', async () => {
    const w = attachedWorld(MODES.same)

    w.inst.registry.value.campaigns.s3 = campaignEntry('s3', MODES.same)
    w.inst.files.set('campaign-s3', { version: 99, records: {} })
    await milestones.saveMilestone(w.repo, scope('b1', 100000, 's1'), { t: 4000, type: 'other', text: 'kept' })

    const read = milestones.readAttachedMilestones(w.repo, scope(), null, [])

    assert.deepEqual(read.entries.map((entry) => entry.text), ['kept'])
    assert.deepEqual(read.refused.map((source) => source.campaignId), ['s3'])

    w.inst.registry.value = 'garbage'

    const broken = milestones.readAttachedMilestones(w.repo, scope(), null, [])

    assert.equal(broken.error.code, 'registry-unreadable')
    assert.deepEqual(broken.entries, [])
    assert.equal(milestones.readMilestones(w.repo, scope()).error, null)
    assert.deepEqual(milestones.readAttachedMilestones(make().repo, scope(), null, []).entries, [])
    assert.deepEqual(milestones.readAttachedMilestones(null, scope(), null, []), { entries: [], notes: [], refused: [], error: null })
    assert.equal((await milestones.adoptMilestone(w.repo, scope(), { uuid: 'x' })).code, 'invalid-milestone')
  })

  // ---- saves --------------------------------------------------------------------------------------------------------

  check('saves', 'on the owner\'s consecutive saves the objects load with the real queries and a link to an event resolves in the later save by its increment and content', async () => {
    const found = await realPair(m)

    if (!found) {
      return { skipped: `the owner's saves are not in ${path.relative(root, SAVES) || SAVES}` }
    }

    try {
      const { first, second } = found
      const w = make()
      const loadedFirst = await milestones.loadObjects(first.database, { GameID: first.GameID, RaceID: first.RaceID })

      assert.deepEqual(loadedFirst.failed, {})
      Object.entries(loadedFirst.objects).forEach(([type, rows]) => assert.ok(rows.size > 0, `${type} has rows in the earlier save`))

      const sharedRows = found.shared
      const picks = milestones.linkChoices(loadedFirst.objects, 'event').slice(0, 60)

      assert.ok(picks.length > 0)

      for (const pick of picks) {
        await added(w, scope(), { t: pick.row.time, text: pick.name.slice(0, 80) || 'event', link: { type: 'event', row: pick.row } })
      }

      const wanted = milestones.incrementsOf(entriesOf(w, scope()))
      const loadedSecond = await milestones.loadObjects(second.database, { GameID: second.GameID, RaceID: second.RaceID, increments: wanted })

      assert.deepEqual(loadedSecond.failed, {})

      const entries = entriesOf(w, scope(), { objects: loadedSecond.objects })
      const counts = { linked: 0, ambiguous: 0, changed: 0, missing: 0 }

      entries.forEach((entry) => {
        const now = loadedSecond.objects.event.get(entry.link.id)
        const was = loadedFirst.objects.event.get(entry.link.id)
        const expected = now ? (now.copies === was.copies ? (now.copies > 1 ? 'ambiguous' : 'linked') : 'changed') : 'missing'

        assert.equal(entry.link.status, expected, `${entry.link.id} ${entry.text}`)
        counts[entry.link.status] += 1
      })

      assert.ok(counts.linked > 0, `a link made in the earlier save resolves in the later one (${JSON.stringify(counts)})`)
      assert.ok(sharedRows.shared > 100, `the saves share log rows (${sharedRows.shared})`)
      assert.ok(sharedRows.sameRowid / sharedRows.shared < 0.01, `row numbers survive between saves: ${sharedRows.sameRowid} of ${sharedRows.shared}`)
      assert.ok(sharedRows.sameKey === sharedRows.shared, 'the shared rows keep their key')

      const stable = []

      for (const type of ['colony', 'system', 'fleet', 'ship']) {
        let both = 0
        let same = 0
        let pruned = 0

        loadedFirst.objects[type].forEach((row, id) => {
          const later = loadedSecond.objects[type].get(id)

          if (later) {
            const alike = milestones.LINK_TYPES[type].fingerprint(row) === milestones.LINK_TYPES[type].fingerprint(later)
            const lost = !alike && type === 'fleet' && row.created !== null && later.created === null

            both += 1
            same += alike ? 1 : 0
            pruned += lost ? 1 : 0
          }
        })

        assert.ok(both > 0, `${type}: both saves hold some`)
        assert.equal(same + pruned, both, `${type}: objects both saves hold keep their fingerprint, apart from a fleet whose creation entry was pruned from its history`)
        stable.push(`${both} ${type}${pruned ? ` (${pruned} with a creation entry pruned)` : ''}`)
      }

      return `${first.name} then ${second.name}: ${sharedRows.shared} of ${sharedRows.rows} log rows of the earlier save kept their increment and content in the later one and ${sharedRows.sameRowid} kept their row number; ${counts.linked} event links linked, ${counts.ambiguous} ambiguous, ${counts.changed} changed, ${counts.missing} missing; ${stable.join(', ')} objects in both keep their fingerprint`
    } finally {
      found.close()
    }
  })

  // ---- backup -------------------------------------------------------------------------------------------------------

  const annotated = (inst, ids = 0) => {
    const w = world(m, inst)
    const repository = m.records.createRepository({ storage: inst.storage, adapters: w.registry, newId: () => uuid(++ids), now: () => 1000 + ids })

    return { repository, adapter: m.backup.annotationsOf(repository, inst.storage), registry: w.registry }
  }

  check('backup', 'milestones round-trip through the backup\'s annotation adapter with their exact time, link, policy and uuid', async () => {
    const source = annotated(memory(), 0)
    const colonies = [colony(5, 'Earth')]

    await milestones.saveMilestone(source.repository, scope('b1'), { t: 1337.5, type: 'battle', text: 'between samples', link: link('colony', colonies[0]), context: contextOf(scope('b1'), link('colony', colonies[0])), policy: 'campaign' })
    await milestones.saveMilestone(source.repository, scope('b1'), { t: 99, type: 'loss', text: 'branch only', policy: 'branch' })

    const bundle = source.adapter.export(scope('b1'))

    assert.equal(bundle.records.length, 2)
    assert.deepEqual(source.adapter.groups('c1'), [{ RaceID: 7, branchId: 'b1' }])

    const target = annotated(memory(), 1000)
    const place = { campaignId: 'c1', RaceID: 7, branch: 'b1' }
    const preview = target.adapter.preview(bundle, place, { restore: true })

    assert.equal(preview.items.every((item) => item.status === 'import'), true, JSON.stringify(preview).slice(0, 300))
    assert.equal(target.adapter.import(bundle, place, { preview, restore: true }).imported.length, 2)

    const entries = milestones.readMilestones(target.repository, scope('b1'), objectsOf(m, { colonies })).entries
    const [exact, pinned] = [entries.find((entry) => entry.text === 'between samples'), entries.find((entry) => entry.text === 'branch only')]

    assert.equal(exact.t, 1337.5)
    assert.equal(exact.link.status, 'unknown')
    assert.equal(exact.link.name, 'Earth')
    assert.equal(exact.policy, 'campaign')
    assert.equal(pinned.policy, 'branch')
    assert.deepEqual(entries.map((entry) => entry.uuid).sort(), bundle.records.map((record) => record.uuid).sort())
  })

  check('backup', 'a kind the installation has no adapter for is refused, so a backup needs the adapter registered', async () => {
    const source = annotated(memory(), 0)

    await milestones.saveMilestone(source.repository, scope('b1'), { t: 5, type: 'other', text: 'a' })

    const bundle = source.adapter.export(scope('b1'))
    const bare = memory()
    const registry = m.records.createAdapterRegistry()
    const repository = m.records.createRepository({ storage: bare.storage, adapters: registry, now: () => 1 })
    const adapter = m.backup.annotationsOf(repository, bare.storage)
    const preview = adapter.preview(bundle, { campaignId: 'c1', RaceID: 7, branch: 'b1' }, { restore: true })

    assert.equal(preview.items.every((item) => item.status === 'rejected'), true)
  })

  check('backup', 'a backup without milestones leaves the stored ones as they are, and an older bundle of other kinds is still read', async () => {
    const target = annotated(memory(), 0)

    await milestones.saveMilestone(target.repository, scope('b1'), { t: 5, type: 'other', text: 'kept' })

    const before = JSON.stringify(target.adapter.export(scope('b1')).records)
    const emptyBundle = { format: 'aurora-scenario-records', version: 1, exportedAt: 1, source: scope('b1'), records: [] }
    const place = { campaignId: 'c1', RaceID: 7, branch: 'b1' }
    const preview = target.adapter.preview(emptyBundle, place, { restore: true })

    assert.equal(target.adapter.import(emptyBundle, place, { preview, restore: true }).imported.length, 0)
    assert.equal(JSON.stringify(target.adapter.export(scope('b1')).records), before)
    assert.equal(milestones.readMilestones(target.repository, scope('b1')).entries.length, 1)
  })

  // ---- page ---------------------------------------------------------------------------------------------------------

  return checks
}

// ---- The owner's consecutive saves (read only) ------------------------------------------------------------------------

const realPair = async (m) => {
  if (!fs.existsSync(SAVES)) {
    return null
  }

  const sqlite3 = localRequire('sqlite3')
  const files = fs.readdirSync(SAVES).filter((name) => name.endsWith('.db'))
  const opened = []
  const close = () => opened.forEach((db) => db.close())
  const open = (name) => {
    const db = new sqlite3.Database(path.join(SAVES, name), sqlite3.OPEN_READONLY)
    const run = (sql, params = {}) => new Promise((resolve, reject) => db.all(sql, Object.fromEntries(Object.entries(params).map(([key, value]) => [`:${key}`, value])), (error, rows) => (error ? reject(error) : resolve(rows))))

    opened.push(db)

    return { name, run, database: { query: async (sql, { replacements = {} } = {}) => [await run(sql, replacements)] } }
  }

  try {
    const GameID = 140
    const RaceID = 784
    const saves = []

    for (const name of files) {
      const save = open(name)
      const [game] = await save.run('select GameTime from FCT_Game where GameID = :GameID', { GameID })

      if (game) {
        saves.push({ ...save, GameID, RaceID, GameTime: game.GameTime })
      }
    }

    saves.sort((a, b) => a.GameTime - b.GameTime)

    if (saves.length < 2) {
      close()

      return null
    }

    let best = 0

    for (let index = 1; index < saves.length - 1; index += 1) {
      if (saves[index + 1].GameTime - saves[index].GameTime < saves[best + 1].GameTime - saves[best].GameTime) {
        best = index
      }
    }

    const [first, second] = [saves[best], saves[best + 1]]
    const rowsOf = (save) => save.run('select rowid as RowNumber, IncrementID, Time, EventType, MessageText, SystemID, PopulationID, Xcor, Ycor, IDType from FCT_GameLog where GameID = :GameID and RaceID = :RaceID', { GameID, RaceID })
    const [rowsFirst, rowsSecond] = [await rowsOf(first), await rowsOf(second)]
    const secondBy = new Map()

    rowsSecond.forEach((row) => {
      const key = m.milestones.eventKey(row)

      secondBy.set(key, [...(secondBy.get(key) || []), row])
    })

    const shared = { rows: rowsFirst.length, shared: 0, sameRowid: 0, sameKey: 0 }

    rowsFirst.forEach((row) => {
      const twins = secondBy.get(m.milestones.eventKey(row))

      if (twins) {
        shared.shared += 1
        shared.sameKey += 1
        shared.sameRowid += twins.some((twin) => twin.RowNumber === row.RowNumber) ? 1 : 0
      }
    })

    return { first, second, shared, close }
  } catch (error) {
    close()
    throw error
  }
}

// ---- The page --------------------------------------------------------------------------------------------------------

const pageSource = () => fs.readFileSync(pageFile, 'utf8').replace(/\r\n/g, '\n')

const pageSuite = async (m, { mutate = null } = {}) => {
  const options = await loadPage('pages/history', { stubs: STUBS, mutate })
  const checks = []
  const check = (name, run) => checks.push({ group: 'page', name, run })
  const { milestones } = m

  const snapshot = (t) => ({ t, population: t / 10, colonies: 3, wealth: 100, income: 5, fuel: 1000, msp: 10, minerals: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], militaryTons: 10, commercialTons: 10, installations: { 1: 5 }, research: 5, systems: 8 })

  const times = [0, 10 * DAY, 30 * DAY, 60 * DAY, 160 * DAY]

  const OPEN_SAVE = { name: 'the open save' }

  const mounted = ({ campaign = { campaignId: 'c1', branchId: 'b1', generation: 1 }, GameTime = 160 * DAY, data = {}, database = OPEN_SAVE } = {}) => {
    const w = world(m)
    const file = { gameName: 'Game', races: { 7: { raceName: 'Test', npr: false, snapshots: times.map(snapshot) } } }
    const store = { getters: { config: { get: (_key, fallback) => fallback }, database, GameID: 1, GameTime, RaceID: 7, StartYear: START_YEAR, historyRecorded: true, 'history/campaign': campaign }, state: { history: { revision: 0 } } }
    const vm = instantiate(options, { $store: store, database, GameID: 1, RaceID: 7, data: { gameHistory: file, campaignView: null, theme: { categorical: ['#111', '#222', '#333'] }, records: { repository: w.repo, error: null }, ...data } })

    return { vm, w, store }
  }

  // The objects of the open save as the page's read keeps them: for the save, game and race they were read for.
  const bundleOf = (store, found) => ({ objects: objectsOf(m, found).objects, failed: {}, GameID: 1, RaceID: 7, database: store.getters.database })

  const guidesOf = (vm) => vm.charts.map((chart) => chart.options.plugins.guides)

  check('the Milestones panel is a panel that names what it is for in the page\'s voice, without the changing figures', () => {
    const text = pageSource()
    const start = text.indexOf('<v-card class="panel history-milestones"')

    assert.ok(start > 0, 'the panel is in the template')

    const tag = text.slice(start, text.indexOf('>', start))
    const summary = /data-summary="([^"]+)"/.exec(tag)

    assert.ok(summary, 'the start tag carries a data-summary')
    assert.ok(summary[1].length > 60 && summary[1].length < 600)
    assert.doesNotMatch(summary[1], /\b(I|me|my|we|our|you|your)\b/i)
    assert.doesNotMatch(summary[1], /\d/)
    assert.match(text.slice(start, start + 600), /<div class="panel-head">\s*<span>Milestones<\/span>/)
  })

  check('every chart carries the markers of the milestones at their exact time, between the samples', async () => {
    const { vm, w } = mounted()

    await milestones.saveMilestone(w.repo, scope(), { t: 15 * DAY + 777, type: 'battle', text: 'between samples' })
    vm.milestoneRevision += 1

    const guides = guidesOf(vm)

    assert.ok(guides.length >= 6)
    guides.forEach((guide) => {
      assert.equal(guide.markers.length, 1)
      assert.equal(guide.markers[0].x, START_YEAR + (15 * DAY + 777) / YEAR)
      assert.equal(guide.markers[0].label, 'Battle')
    })
    assert.equal(vm.options({ y: String }).plugins.guides.markers[0].x, START_YEAR + (15 * DAY + 777) / YEAR)
    assert.equal(vm.milestoneEntries[0].sample.offsetText, `${vm.duration(5 * DAY + 777)} before it`)
    assert.equal(vm.milestoneEntries[0].sample.dateText, milestones.gameDateText(START_YEAR, 10 * DAY))
    assert.equal(vm.milestoneEntries[0].dateText, milestones.gameDateText(START_YEAR, 15 * DAY + 777))
  })

  check('the marker keeps its x on the percent scale of the mineral chart, in another span and after the axes change', async () => {
    const { vm, w } = mounted()

    await milestones.saveMilestone(w.repo, scope(), { t: 45 * DAY + 5, type: 'discovery', text: 'x' })
    vm.milestoneRevision += 1

    const x = START_YEAR + (45 * DAY + 5) / YEAR
    const xs = () => guidesOf(vm).map((guide) => guide.markers.map((marker) => marker.x))

    assert.deepEqual(xs(), guidesOf(vm).map(() => [x]))

    vm.mineralScale = 'percent'

    const percent = vm.charts.find((chart) => chart.key === 'minerals').options.plugins.guides

    assert.deepEqual(percent.markers.map((marker) => marker.x), [x])
    assert.deepEqual(percent.levels, [{ y: 0 }])
    assert.deepEqual(xs(), guidesOf(vm).map(() => [x]))

    vm.span = 10
    vm.mineralScale = 'absolute'

    assert.deepEqual(xs(), guidesOf(vm).map(() => [x]))
    assert.equal(vm.options({ y: String }).scales.x.type, 'linear')
  })

  check('a milestone that the samples shown do not reach is listed and not drawn, and one ahead of the save is listed and not drawn', async () => {
    const { vm, w } = mounted({ GameTime: 60 * DAY })

    await milestones.saveMilestone(w.repo, scope('b1', 160 * DAY), { t: 100 * DAY, type: 'other', text: 'later than the save' })
    await milestones.saveMilestone(w.repo, scope('b1', 60 * DAY), { t: 20 * DAY, type: 'other', text: 'before' })
    await milestones.saveMilestone(w.repo, scope('b1', 60 * DAY), { t: 400 * DAY, type: 'other', text: 'beyond' })
    vm.milestoneRevision += 1

    assert.deepEqual(vm.milestoneEntries.map((entry) => [entry.text, entry.ahead, entry.drawn]), [['before', false, true], ['later than the save', true, false], ['beyond', false, false]])
    assert.deepEqual(vm.milestoneMarkers.map((marker) => marker.x), [START_YEAR + 20 * DAY / YEAR])
  })

  check('the form keeps the exact time of a milestone it edits unless the date is retyped, and a typed date is that of the game clock', async () => {
    const { vm, w } = mounted()

    await milestones.saveMilestone(w.repo, scope(), { t: 3 * DAY + 12.25, type: 'battle', text: 'fractional' })
    vm.milestoneRevision += 1
    vm.editMilestone(vm.milestoneEntries[0])
    vm.milestoneDraft.text = 'fractional, reworded'
    await vm.saveMilestoneDraft(false)

    assert.equal(vm.milestoneMessageType, 'success', vm.milestoneMessage)
    assert.equal(vm.milestoneRead.entries[0].t, 3 * DAY + 12.25)
    assert.equal(vm.milestoneRead.entries[0].text, 'fractional, reworded')

    vm.editMilestone(vm.milestoneEntries[0])
    vm.milestoneDraft.date = '2050-01-05 00:00:00'
    assert.deepEqual(vm.milestoneTime, { ok: true, seconds: 4 * DAY })
    await vm.saveMilestoneDraft(false)
    assert.equal(vm.milestoneRead.entries[0].t, 4 * DAY)

    vm.milestoneDraft.date = '2050-02-30'
    assert.equal(vm.milestoneTime.ok, false)
    vm.milestoneDraft.text = 'new'
    await vm.saveMilestoneDraft(false)
    assert.equal(vm.milestoneRead.entries.length, 1)
  })

  check('a new milestone with no date is made at the game time of the save, and the form is empty again after it', async () => {
    const { vm } = mounted({ GameTime: 77 * DAY + 5 })

    vm.milestoneDraft.text = 'now'
    assert.deepEqual(vm.milestoneTime, { ok: true, seconds: 77 * DAY + 5 })
    assert.equal(vm.milestoneReady, true)
    await vm.saveMilestoneDraft(false)

    assert.equal(vm.milestoneRead.entries[0].t, 77 * DAY + 5)
    assert.equal(vm.milestoneDraft.text, '')
    assert.equal(vm.milestoneRead.entries[0].policy, 'campaign')

    vm.milestoneDraft.text = 'branch'
    vm.milestoneDraft.branchOnly = true
    await vm.saveMilestoneDraft(false)
    assert.equal(vm.milestoneRead.entries.find((entry) => entry.text === 'branch').policy, 'branch')
  })

  check('a stale edit of the form is not written over silently: the conflict is shown and only the explicit write goes over it', async () => {
    const { vm, w } = mounted()

    await milestones.saveMilestone(w.repo, scope(), { t: 5 * DAY, type: 'battle', text: 'first' })
    vm.milestoneRevision += 1
    vm.editMilestone(vm.milestoneEntries[0])

    const other = world(m, w.inst)

    await milestones.saveMilestone(other.repo, scope(), { entry: vm.milestoneRead.entries[0], t: 5 * DAY, type: 'battle', text: 'changed elsewhere' })
    vm.milestoneDraft.text = 'changed here'
    await vm.saveMilestoneDraft(false)

    assert.ok(vm.milestoneConflict)
    assert.equal(vm.milestoneConflict.text, 'changed elsewhere')
    assert.equal(vm.milestoneRead.entries[0].text, 'changed elsewhere')
    assert.equal(vm.milestoneDraft.text, 'changed here')

    await vm.saveMilestoneDraft(true)
    assert.equal(vm.milestoneConflict, null)
    assert.equal(vm.milestoneRead.entries[0].text, 'changed here')
  })

  check('a delete asks again before it deletes, and a link to a deleted object stays on the entry as unresolved in the list', async () => {
    const { vm, w, store } = mounted({ campaign: { campaignId: 'c1', branchId: 'b1', generation: 1 } })
    const ships = [ship(12, 'Hood', 500)]

    await milestones.saveMilestone(w.repo, scope('b1', 160 * DAY), { t: 5 * DAY, type: 'colonisation', text: 'Landing', link: link('ship', ships[0]), context: contextOf(scope('b1', 160 * DAY), link('ship', ships[0])) })
    vm.milestoneObjects = bundleOf(store, { ships })
    vm.milestoneRevision += 1

    assert.equal(vm.milestoneEntries[0].link.status, 'linked')

    vm.milestoneObjects = bundleOf(store, { ships: [] })
    vm.milestoneRevision += 1

    assert.equal(vm.milestoneEntries[0].link.status, 'missing')
    assert.equal(vm.milestoneEntries[0].link.word, 'unresolved, gone')
    assert.equal(vm.milestoneEntries[0].unresolved, true)
    assert.equal(vm.milestoneEntries[0].t, 5 * DAY)

    await vm.deleteMilestoneEntry(vm.milestoneEntries[0])
    assert.equal(vm.milestoneEntries.length, 0)
    assert.equal(vm.milestoneMessageType, 'success')
  })

  check('the links of a branch that is not the open save\'s are not checked against the open save', async () => {
    const { vm, w, store } = mounted({ GameTime: 160 * DAY, data: { campaignView: { branches: [{ id: 'b1' }, { id: 'b2' }] } } })
    const colonies = [colony(5, 'Earth')]

    await milestones.saveMilestone(w.repo, scope('b1', 160 * DAY), { t: 5 * DAY, type: 'colonisation', text: 'Landing', link: link('colony', colonies[0]), context: contextOf(scope('b1', 160 * DAY), link('colony', colonies[0])) })
    vm.milestoneObjects = bundleOf(store, { colonies: [] })
    vm.branchChoice = 'b1'
    vm.milestoneRevision += 1
    assert.equal(vm.milestoneEntries[0].link.status, 'missing')

    store.getters['history/campaign'] = { campaignId: 'c1', branchId: 'b2', generation: 1 }
    vm.milestoneRevision += 1
    assert.equal(vm.milestoneContext, null)
    assert.equal(vm.milestoneEntries[0].link.status, 'unknown')
  })

  check('a draft belongs to the campaign, race and branch it was filled in for: another one empties it, and a save of it is refused with nothing written', async () => {
    const { vm, w, store } = mounted({ data: { campaignView: { branches: [{ id: 'b1' }, { id: 'b2' }] } } })
    const colonies = [colony(5, 'Earth')]

    vm.branchChoice = 'b1'
    vm.milestoneObjects = bundleOf(store, { colonies })
    vm.milestoneDraft.linkKind = 'colony'
    vm.milestoneDraft.text = 'Landing'
    vm.milestoneDraft.linkPick = vm.milestoneChoices[0]
    vm.pickMilestoneLink(vm.milestoneChoices[0])
    assert.equal(vm.milestoneDraft.scopeKey, 'c1|7|b1')
    assert.equal(vm.milestoneReady, true)

    vm.branchChoice = 'b2'
    assert.equal(vm.milestoneScopeKey, 'c1|7|b2')
    await vm.saveMilestoneDraft(false)

    assert.match(vm.milestoneMessage, /changed after this form/)
    assert.equal(vm.milestoneDraft.text, '')
    assert.equal(vm.milestoneDraft.linkKind, 'none')
    assert.equal(w.inst.files.has('campaign-c1'), false, 'nothing was written')

    vm.milestoneDraft.text = 'again'
    vm.milestoneDraft.linkKind = 'colony'
    options.watch.milestoneScopeKey.call(vm)
    assert.equal(vm.milestoneDraft.text, '')
    assert.equal(vm.milestoneDraft.linkKind, 'none')
    assert.equal(vm.milestoneDraft.scopeKey, null)
    assert.match(vm.milestoneMessage, /was emptied/)

    vm.branchChoice = 'b1'
    vm.milestoneDraft.linkKind = 'colony'
    assert.equal(vm.milestoneChoices.length, 1)
    store.getters.RaceID = 8
    assert.equal(vm.milestoneScopeKey, 'c1|8|b1')
    assert.deepEqual(vm.milestoneChoices, [])
    assert.equal(vm.milestoneContext, null)
  })

  check('the objects read for another save, game or race are not used: no link is checked against them', async () => {
    const { vm, w, store } = mounted()
    const ships = [ship(12, 'Hood', 500)]

    await milestones.saveMilestone(w.repo, scope('b1', 160 * DAY), { t: 5 * DAY, type: 'colonisation', text: 'Landing', link: link('ship', ships[0]), context: contextOf(scope('b1', 160 * DAY), link('ship', ships[0])) })

    const fresh = bundleOf(store, { ships })

    vm.milestoneObjects = fresh
    vm.milestoneRevision += 1
    assert.equal(vm.milestoneEntries[0].link.status, 'linked')

    for (const other of [{ database: { name: 'another save' } }, { GameID: 2 }, { RaceID: 8 }]) {
      vm.milestoneObjects = { ...fresh, ...other }
      vm.milestoneRevision += 1
      assert.equal(vm.milestoneContext, null)
      assert.equal(vm.milestoneEntries[0].link.status, 'unknown')
    }
  })

  check('the read of the objects carries the save, game and race it was made for', async () => {
    const { vm, store } = mounted()
    const opened = fakeSave({ colonies: [colony(5, 'Earth')], systems: [], fleets: [], ships: [], events: [] })

    store.getters.database = opened
    vm.milestoneDraft.linkKind = 'colony'

    const bundle = await vm.runAsync('milestoneObjects')

    assert.equal(bundle.database, opened)
    assert.equal(bundle.GameID, 1)
    assert.equal(bundle.RaceID, 7)
    assert.equal(vm.milestoneContext.objects.colony.size, 1)

    store.getters.database = fakeSave({ colonies: [], systems: [], fleets: [], ships: [], events: [] })
    assert.equal(vm.milestoneContext, null)
  })

  check('the milestones of an attached campaign are listed apart, never drawn, and adopted only when the player asks, once', async () => {
    const { vm, w } = mounted()

    w.inst.registry.value = { campaigns: { c1: campaignEntry('c1'), s1: campaignEntry('s1', { campaignId: 'c1', branchId: 'b1', at: 5 }) } }
    await milestones.saveMilestone(w.repo, scope('b1', 160 * DAY, 's1'), { t: 20 * DAY, type: 'battle', text: 'Over there' })
    vm.milestoneRevision += 1

    assert.deepEqual(vm.milestoneAttached.entries.map((entry) => [entry.text, entry.adopted, entry.typeText]), [['Over there', false, 'Battle']])
    assert.equal(vm.milestoneEntries.length, 0)
    assert.equal(vm.milestoneMarkers.length, 0)
    guidesOf(vm).forEach((guide) => assert.equal(guide.markers.length, 0))

    await vm.adoptMilestoneEntry(vm.milestoneAttached.entries[0])
    assert.equal(vm.milestoneMessageType, 'success', vm.milestoneMessage)
    assert.equal(vm.milestoneEntries.length, 1)
    assert.equal(vm.milestoneMarkers.length, 1)
    assert.equal(vm.milestoneAttached.entries[0].adopted, true)

    await vm.adoptMilestoneEntry(vm.milestoneAttached.entries[0])
    assert.match(vm.milestoneMessage, /adopted already/)
    assert.equal(vm.milestoneEntries.length, 1)
  })

  check('an attached milestone adopted onto one branch reads as adopted on the other branch shown, names the branch that holds the copy, and is not offered again', async () => {
    const { vm, w } = mounted({ data: { campaignView: { branches: [{ id: 'b1' }, { id: 'b2' }] }, milestoneBranches: TREE } })

    w.inst.registry.value = { campaigns: { c1: campaignEntry('c1'), s1: campaignEntry('s1', { campaignId: 'c1', branchId: 'b1', at: 5 }) } }
    await milestones.saveMilestone(w.repo, scope('b1', 160 * DAY, 's1'), { t: 20 * DAY, type: 'battle', text: 'Over there', policy: 'branch' })

    vm.branchChoice = 'b1'
    vm.milestoneRevision += 1
    assert.equal(vm.milestoneAttached.entries[0].adopted, false)

    vm.branchChoice = 'b2'
    vm.milestoneRevision += 1
    await vm.adoptMilestoneEntry(vm.milestoneAttached.entries[0])
    assert.equal(vm.milestoneMessageType, 'success', vm.milestoneMessage)
    assert.equal(vm.milestoneAttached.entries[0].adopted, true)
    assert.match(vm.adoptedText(vm.milestoneAttached.entries[0].adoptedOn), /this branch only/)

    vm.branchChoice = 'b1'
    vm.milestoneRevision += 1

    const [entry] = vm.milestoneAttached.entries

    assert.equal(entry.adopted, true, 'the shown branch does not hold the copy, the campaign does')
    assert.equal(entry.adoptedOn.branchId, 'b2')
    assert.match(vm.adoptedText(entry.adoptedOn), /branch b2 only/)
    assert.equal(vm.milestoneEntries.length, 0, 'a copy kept for branch b2 is not listed on b1')
    assert.match(pageSource(), /:data-milestone-adopted-on="entry\.adoptedOn\.branchId"/)

    const copy = { policy: 'campaign', branchId: 'b2' }

    assert.match(vm.adoptedText(copy), /every branch/)
  })

  check('a link made on another branch is checked against the lineage of the campaign the page reads: a fleet is not told, a ship built before the branches parted is', async () => {
    const { vm, w, store } = mounted({ data: { milestoneBranches: TREE } })
    const there = scope('b2', 160 * DAY)
    const [fleetOf, early, late] = [link('fleet', fleet(8, '1st Fleet', 1500)), link('ship', ship(12, 'Hood', 500)), link('ship', ship(13, 'Rodney', 1500))]

    for (const [text, pick] of [['fleet', fleetOf], ['early', early], ['late', late]]) {
      await milestones.saveMilestone(w.repo, there, { t: 5 * DAY, type: 'other', text, link: pick, context: contextOf(there, pick) })
    }

    vm.milestoneObjects = bundleOf(store, { fleets: [fleet(8, 'Another', 1500)], ships: [ship(12, 'Hood', 500), ship(13, 'Rodney', 1500)] })
    vm.milestoneRevision += 1

    assert.equal(vm.milestoneContext.branchId, 'b1')
    assert.deepEqual(vm.milestoneEntries.map((entry) => [entry.text, entry.link.status]).sort(), [['early', 'linked'], ['fleet', 'unknown'], ['late', 'unknown']])
    assert.equal(vm.milestoneEntries.find((entry) => entry.text === 'fleet').unresolved, false)
  })

  check('the backup registers the milestone adapter with the records it exports and restores', () => {
    const text = mutate ? mutate(pageSource()) : pageSource()
    const start = text.indexOf('async backupAnnotations()')
    const end = text.indexOf('stamp(milliseconds)', start)

    assert.ok(start > 0 && end > start)
    assert.match(text.slice(start, end), /registerMilestones\(records\.registerAdapter\)/)
  })

  return checks
}

// ---- Mutants ---------------------------------------------------------------------------------------------------------

const UTILITY_MUTATIONS = [
  { name: 'a marker is drawn at the nearest sample', file: 'history-milestones.js', find: 'x: position(entry.t), label', replace: 'x: position(nearestSample(snapshots, entry.t).sampleT), label', fails: ['time: a milestone between two samples keeps its exact position', 'time: the marker x is a function of the exact time alone'] },
  { name: 'the time is rounded to the second when it is kept', file: 'history-milestones.js', find: "const payload = { t: typeof t === 'string' && t.trim() !== '' ? Number(t) : t,", replace: "const payload = { t: Math.round(typeof t === 'string' && t.trim() !== '' ? Number(t) : t),", fails: ['time: the exact time, fractions included', 'backup: milestones round-trip'] },
  { name: 'a milestone outside the samples is drawn', file: 'history-milestones.js', find: 'export const withinSamples = (snapshots, t) => snapshots.length > 0 && t >= snapshots[0].t && t <= snapshots[snapshots.length - 1].t', replace: 'export const withinSamples = () => true', fails: ['time: a milestone outside the samples shown is not drawn'] },
  { name: 'the date is not checked against the calendar', file: 'history-milestones.js', find: 'if (gameDateText(year, (date.getTime() - yearStart(year)) / 1000) !== typed) {', replace: 'if (false) {', fails: ['time: a typed date that is no date of the calendar'] },
  { name: 'an edit without a link drops the link the milestone has', file: 'history-milestones.js', find: '...(link === undefined ? {} : { links })', replace: '...{ links }', fails: ['edits: an edit changes the fields it names', 'links: an edit keeps the link the milestone has'] },
  { name: 'a new milestone is kept for its branch whatever is asked', file: 'history-milestones.js', find: "policy: policy || 'campaign', links", replace: "policy: 'branch', links", fails: ['branches: a campaign milestone shows on every branch', 'edits: a milestone is made with a type'] },
  { name: 'a stale edit is written over without asking', file: 'history-milestones.js', find: '      if (!overwrite) {\n        return { ok: false, code: \'revision-conflict\', message: error.message, stored: copyOf(error.stored.payload), revision: error.stored.revision }\n      }\n\n      return { ok: true, record: repository.reconcile(scope, error, patch) }', replace: '      return { ok: true, record: repository.reconcile(scope, error, patch) }', fails: ['edits: a stale edit is refused'] },
  { name: 'a milestone ahead of the save is drawn', file: 'history-milestones.js', find: 'entries.filter((entry) => !entry.ahead && withinSamples(snapshots, entry.t))', replace: 'entries.filter((entry) => withinSamples(snapshots, entry.t))', fails: ['branches: a milestone made at a later game time than a rewound save is ahead'] },
  { name: 'a link whose object is gone is rebound to the object with the same content', file: 'history-milestones.js', find: 'return objects.get(link.id) || null', replace: 'return objects.get(link.id) || [...objects.values()].find((row) => linkTypeOf(link.type).fingerprint(row) === link.fingerprint) || null', fails: ['links: a link is never rebound by name'] },
  { name: 'an ID reused by another object is trusted', file: 'history-milestones.js', find: "fingerprint: (row) => ['colony', present(row.systemId), present(row.bodyId), present(row.speciesId)].join('|'),", replace: "fingerprint: (row) => 'colony',", fails: ['links: an ID that a save reuses for another object is changed', 'links: a colony is never linked'] },
  { name: 'a colony is told by its name', file: 'history-milestones.js', find: "fingerprint: (row) => ['colony', present(row.systemId), present(row.bodyId), present(row.speciesId)].join('|'),", replace: "fingerprint: (row) => ['colony', row.name, present(row.systemId), present(row.bodyId), present(row.speciesId)].join('|'),", fails: ['links: a colony is never linked'] },
  { name: 'a colony is not told by its species', file: 'history-milestones.js', find: "present(row.bodyId), present(row.speciesId)].join('|'),", replace: "present(row.bodyId)].join('|'),", fails: ['links: a colony is never linked'] },
  { name: 'a system is told by its name', file: 'history-milestones.js', find: "fingerprint: (row) => ['system', present(row.number), present(row.stars), present(row.discovered)].join('|'),", replace: "fingerprint: (row) => ['system', row.name, present(row.number), present(row.stars), present(row.discovered)].join('|'),", fails: ['links: a renamed system stays linked'] },
  { name: 'a fleet is told by its name', file: 'history-milestones.js', find: "fingerprint: (row) => ['fleet', present(row.created)].join('|'),", replace: "fingerprint: (row) => ['fleet', present(row.created), row.name].join('|'),", fails: ['links: a renamed fleet stays linked'] },
  { name: 'a ship is told by its name', file: 'history-milestones.js', find: "fingerprint: (row) => ['ship', present(row.constructed)].join('|'),", replace: "fingerprint: (row) => ['ship', row.name, present(row.constructed)].join('|'),", fails: ['links: a renamed ship stays linked'] },
  { name: 'a kind of object the save could not give reads as missing', file: 'history-milestones.js', find: 'throw new TypeError(`the #{link.type} objects of the save were not read`)', replace: 'return null', fails: ['links: a link read with no save, or to a kind of object the save could not give, is unknown'] },
  { name: 'the event key is the row number', file: 'history-milestones.js', find: 'export const eventKey = (row) => `#{row.IncrementID}:#{hashText(eventContent(row))}#{hashText(eventContent(row), 0x9e3779b1)}`', replace: 'export const eventKey = (row) => `#{row.IncrementID}:#{row.RowID === undefined ? row.RowNumber : row.RowID}`', fails: ['links: a log event is named by its increment and its content', 'links: a link to an event made in one save resolves in another whose rows were all renumbered', 'saves: on the owner\'s consecutive saves'] },
  { name: 'the event key leaves out the place a row names', file: 'history-milestones.js', find: "const eventContent = (row) => [row.Time, row.EventType, row.MessageText, row.SystemID, row.PopulationID, row.Xcor, row.Ycor, row.IDType].map(present).join('|')", replace: "const eventContent = (row) => [row.Time, row.EventType, row.MessageText].map(present).join('|')", fails: ['links: the key of a log event holds the place it names', 'links: two rows of the log that say the same in two places'] },
  { name: 'the log query asks for the row number', file: 'history-milestones.js', find: "const EVENT_COLUMNS = 'FCT_GameLog.IncrementID, FCT_GameLog.Time,", replace: "const EVENT_COLUMNS = 'FCT_GameLog.rowid as RowID, FCT_GameLog.IncrementID, FCT_GameLog.Time,", fails: ['links: no query the utility sends names the rowid'] },
  { name: 'the increments a milestone links to are capped', file: 'history-milestones.js', find: 'return [...wanted].sort((a, b) => a - b)', replace: 'return [...wanted].sort((a, b) => a - b).slice(0, 500)', fails: ['links: every event a milestone links to is read, however many'] },
  { name: 'the read of the linked increments stops after one batch', file: 'history-milestones.js', find: 'for (const batch of batchesOf(safe, INCREMENTS_PER_READ)) {', replace: 'for (const batch of batchesOf(safe.slice(0, INCREMENTS_PER_READ), INCREMENTS_PER_READ)) {', fails: ['links: every event a milestone links to is read, however many'] },
  { name: 'a fleet whose creation entry was pruned reads as another fleet', file: 'history-milestones.js', find: "const lost = stored.status === 'changed' && timeLost(stored, currentRowOf(context, stored))", replace: 'const lost = false', fails: ['links: a fleet is the same one only with the creation time'] },
  { name: 'a link that is not known to be the same object counts as unresolved', file: 'history-milestones.js', find: 'unresolved: item.unresolved > 0 && !(link && link.unverified),', replace: 'unresolved: item.unresolved > 0,', fails: ['links: a fleet is the same one only with the creation time'] },
  { name: 'a log event that the log holds twice is not ambiguous in a link', file: 'history-milestones.js', find: "const ambiguous = Boolean(row) && stored.type === 'event' && row.copies > 1", replace: 'const ambiguous = false', fails: ['links: a log event the log holds several times over'] },
  { name: 'a log event that the log holds twice is not ambiguous in the picker', file: 'history-milestones.js', find: "ambiguous: type === 'event' && row.copies > 1 }))", replace: 'ambiguous: false }))', fails: ['links: a log event the log holds several times over'] },
  { name: 'a link is made against whatever the form holds', file: 'history-milestones.js', find: 'const checked = link ? linkChecked(context, scope, link) : null', replace: 'const checked = link ? { ok: true, row: link.row } : null', fails: ['scope: a link is made only against the objects of the race it is kept for', 'scope: the link keeps the name'] },
  { name: 'a link is made against the objects of another race', file: 'history-milestones.js', find: 'context.RaceID !== scope.RaceID', replace: 'false', fails: ['scope: a link is made only against the objects of the race it is kept for'] },
  { name: 'a link is made to an object that is not as it was picked', file: 'history-milestones.js', find: 'if (!current || linkTypeOf(link.type).fingerprint(current) !== linkTypeOf(link.type).fingerprint(link.row)) {', replace: 'if (!current) {', fails: ['scope: a link is made only against the objects of the race it is kept for'] },
  { name: 'the attached campaigns list nothing', file: 'history-milestones.js', find: 'entries: listed.entries.filter((item) => !unreadable(item)).map((item) => ({', replace: 'entries: [].map((item) => ({', fails: ['attached: after an attach in the mode same', 'attached: after an attach in the mode new-branch'] },
  { name: 'an adopted milestone is offered again', file: 'history-milestones.js', find: 'adopted: copyOfItem(item) !== null, adoptedOn: copyOfItem(item) })', replace: 'adopted: false, adoptedOn: null })', fails: ['attached: after an attach in the mode same', 'attached: after an attach in the mode new-branch'] },
  { name: 'a source file that cannot be read is not named', file: 'history-milestones.js', find: 'refused: listed.refused,', replace: 'refused: [],', fails: ['attached: a source file that cannot be read is named'] },
  { name: 'rows the log holds twice are counted once', file: 'history-milestones.js', find: 'found.get(key).copies += 1', replace: 'found.get(key).copies += 0', fails: ['links: a row the log holds twice is one event that counts its copies'] },
  { name: 'a failed read of one kind of object stops the others', file: 'history-milestones.js', find: 'failed[type] = error && error.message ? error.message : String(error)', replace: 'throw error', fails: ['links: a kind of object the save cannot give is named as failed'] },
  { name: 'an object that gives no time is certified', file: 'history-milestones.js', find: 'return UNVERIFIED_TEXT.untimed', replace: 'return null', fails: ['links: a fleet is the same one only with the creation time', 'links: a ship is the same one only with the construction time'] },
  { name: 'a fleet is told by its ID alone', file: 'history-milestones.js', find: "fingerprint: (row) => ['fleet', present(row.created)].join('|'),", replace: "fingerprint: () => 'fleet',", fails: ['links: a fleet is the same one only with the creation time'] },
  { name: 'an object is certified without its time before the branches parted', file: 'history-milestones.js', find: 'return shared !== null && created < shared ? null : UNVERIFIED_TEXT.parted', replace: 'return shared !== null ? null : UNVERIFIED_TEXT.parted', fails: ['links: a fleet is the same one only with the creation time', 'links: a ship is the same one only with the construction time', 'links: a system on another branch is the same one only where', 'links: the game time two branches share'] },
  { name: 'an object is certified when the registry does not say when the branches parted', file: 'history-milestones.js', find: 'return shared !== null && created < shared ? null : UNVERIFIED_TEXT.parted', replace: 'return shared === null || created < shared ? null : UNVERIFIED_TEXT.parted', fails: ['links: the game time two branches share', 'links: a link made in another campaign'] },
  { name: 'a link on the branch it was made on shares nothing', file: 'history-milestones.js', find: 'if (origin.branchId === context.branchId) {\n    return Infinity\n  }', replace: 'if (origin.branchId === context.branchId) {\n    return null\n  }', fails: ['links: a fleet is the same one only with the creation time', 'links: a ship is the same one only with the construction time'] },
  { name: 'two branches share the later of the times they parted at', file: 'history-milestones.js', find: 'Math.min(limit, other)', replace: 'Math.max(limit, other)', fails: ['links: the game time two branches share', 'links: the lineage of a campaign'] },
  { name: 'a branch shares only the time its own parent was left at', file: 'history-milestones.js', find: 'limit = limit === null || t === null ? null : Math.min(limit, t)', replace: 'limit = limit === null || t === null ? null : t', fails: ['links: the lineage of a campaign'] },
  { name: 'a colony is certified by the place it was made with', file: 'history-milestones.js', find: "if (definition.identity === 'unwitnessed') {\n    return UNVERIFIED_TEXT.unwitnessed\n  }", replace: "if (definition.identity === 'unwitnessed') {\n    return null\n  }", fails: ['links: a colony is never linked', 'links: a link to each kind of object is linked'] },
  { name: 'an object made at the very time the branches parted is certified', file: 'history-milestones.js', find: 'shared !== null && created < shared ? null', replace: 'shared !== null && created <= shared ? null', fails: ['links: a ship is the same one only with the construction time', 'links: a fleet is the same one only with the creation time'] },
  { name: 'a link that is not known to be the same object is linked', file: 'history-milestones.js', find: "const status = ambiguous ? 'ambiguous' : unverified ? 'unknown' : stored.status", replace: "const status = ambiguous ? 'ambiguous' : stored.status", fails: ['links: a fleet is the same one only with the creation time', 'links: a ship is the same one only with the construction time'] },
  { name: 'the branch a link was made on is not kept', file: 'history-milestones.js', find: 'origin: { campaignId: scope.campaignId, branchId: scope.branchId } } : null', replace: "origin: { campaignId: scope.campaignId, branchId: 'b1' } } : null", fails: ['links: a fleet is the same one only with the creation time', 'links: a link keeps the campaign and branch it was made on'] },
  { name: 'a record with no origin of its link is read', file: 'history-milestones.js', find: ' && isObject(link.origin) && isText(link.origin.campaignId) && isText(link.origin.branchId)', replace: '', fails: ['links: a link keeps the campaign and branch it was made on'] },
  { name: 'a link is made against the objects of another campaign or branch', file: 'history-milestones.js', find: ' || context.campaignId !== scope.campaignId || context.branchId !== scope.branchId) {', replace: ') {', fails: ['scope: a link is made only against the objects of the race it is kept for', 'links: a link keeps the campaign and branch it was made on'] },
  { name: 'the adoption is read from the shown branch only', file: 'history-milestones.js', find: 'new Set([scope.branchId, ...branchIds])', replace: 'new Set([scope.branchId])', fails: ['attached: a milestone adopted onto one branch reads as adopted'] },
]

const PAGE_MUTATIONS = [
  { name: 'the markers are lost on the percent scale of the mineral chart', mutate: replacing('options.plugins.guides.levels = [{ y: 0 }]', 'options.plugins.guides = { levels: [{ y: 0 }] }'), fails: ['page: the marker keeps its x on the percent scale'] },
  { name: 'the charts carry no markers', mutate: replacing('          guides: { markers: this.milestoneMarkers },\n', ''), fails: ['page: every chart carries the markers', 'page: the marker keeps its x on the percent scale'] },
  { name: 'the page snaps a marker to its nearest sample', mutate: replacing('(seconds) => this.year(seconds))', '(seconds) => this.year(nearestSample(this.allSnapshots, seconds).sampleT))'), fails: ['page: every chart carries the markers', 'page: the marker keeps its x'] },
  { name: 'the form parses the date again even when it is untouched', mutate: replacing('if (draft.t !== null && text === gameDateText(this.StartYear, draft.t)) {', 'if (false) {'), fails: ['page: the form keeps the exact time of a milestone it edits'] },
  { name: 'an edit is made over the revision the list has now, so a stale one is written over', mutate: replacing('{ ...stored, revision: draft.revision }', 'stored'), fails: ['page: a stale edit of the form is not written over silently'] },
  { name: 'the links of another branch are checked against the open save', mutate: replacing('this.milestoneScope.branchId === open.branchId ? { objects: bundle.objects', 'true ? { objects: bundle.objects'), fails: ['page: the links of a branch that is not the open save'] },
  { name: 'a draft is saved for another campaign, race or branch than it was filled in for', mutate: replacing('if (draft.scopeKey !== null && draft.scopeKey !== this.milestoneScopeKey) {', 'if (false) {'), fails: ['page: a draft belongs to'] },
  { name: 'a draft is kept when what is shown changes', mutate: replacing('resetMilestoneDraft() {\n      this.milestoneDraft = blankMilestone()', 'resetMilestoneDraft() {\n      this.milestoneDraft = this.milestoneDraft'), fails: ['page: a draft belongs to'] },
  { name: 'the objects read for another save, game or race are used', mutate: replacing('return bundle && bundle.database === this.database && bundle.GameID === this.GameID && bundle.RaceID === this.RaceID ? bundle : null', 'return bundle'), fails: ['page: the objects read for another save'] },
  { name: 'the read of the objects does not say which save it was for', mutate: replacing('increments: this.milestoneIncrements })), database })', 'increments: this.milestoneIncrements })) })'), fails: ['page: the read of the objects carries'] },
  { name: 'the milestones of attached campaigns are drawn with the campaign\'s own', mutate: replacing('markersOf(this.milestoneRead.entries, this.snapshots,', 'markersOf([...this.milestoneRead.entries, ...this.milestoneAttached.entries], this.snapshots,'), fails: ['page: the milestones of an attached campaign'] },
  { name: 'the backup does not register the adapter', mutate: replacing('        registerMilestones(records.registerAdapter)\n\n        return { adapter', '        return { adapter'), fails: ['page: the backup registers the milestone adapter'] },
  { name: 'the page reads the adoption of the shown branch only', mutate: replacing('Object.keys(this.milestoneBranches || {})', '[]'), fails: ['page: an attached milestone adopted onto one branch'] },
  { name: 'the page does not hand the lineage to the links', mutate: replacing('branchId: open.branchId, branches: this.milestoneBranches }', 'branchId: open.branchId }'), fails: ['page: a link made on another branch'] },
  { name: 'a copy kept for another branch is described as kept for the shown one', mutate: replacing('copy.branchId === this.shownBranchId ?', 'true ?'), fails: ['page: an attached milestone adopted onto one branch'] },
]

const mutatedCopy = ({ file, find, replace }) => {
  const from = unhashed(find)
  const to = unhashed(replace)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-history-milestones-mutant-'))

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

  return { milestones: loaded['history-milestones'], records: loaded['scenario-records'], backup: loaded['history-backup'] }
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

const main = async () => {
  const real = await loadModules(utilitiesDirectory)

  console.log('The milestones: time, edits, branches, links, scope, attached campaigns, saves and backup')

  for (const [name, result, detail, skip] of await runChecks(suite(real))) {
    show(name, result, detail, skip)
  }

  console.log('\nThe Milestones panel of the page (its script over scripts/lib/page-loader.js)')

  for (const [name, result] of await runChecks(await pageSuite(real))) {
    show(name, result)
  }

  if (!process.argv.includes('--no-mutations')) {
    console.log('\nmutants')

    for (const mutant of UTILITY_MUTATIONS.filter((entry) => entry.fails.length)) {
      let directory = null

      try {
        directory = mutatedCopy(mutant)

        const results = await runChecks(suite(await loadModules(directory)), mutant.fails)

        show(`mutant caught: ${mutant.name}`, caught(mutant, results))
      } catch (error) {
        show(`mutant caught: ${mutant.name}`, error.message)
      } finally {
        if (directory) {
          fs.rmSync(directory, { recursive: true, force: true })
        }
      }
    }

    for (const mutant of PAGE_MUTATIONS) {
      try {
        const results = await runChecks(await pageSuite(real, { mutate: mutant.mutate }), mutant.fails)

        show(`mutant caught: ${mutant.name}`, caught(mutant, results))
      } catch (error) {
        show(`mutant caught: ${mutant.name}`, error.message)
      }
    }

    const control = await runChecks(suite(real), [...new Set(UTILITY_MUTATIONS.flatMap((mutant) => mutant.fails))])
    const controlPage = await runChecks(await pageSuite(real), [...new Set(PAGE_MUTATIONS.flatMap((mutant) => mutant.fails))])
    const wrong = [...control, ...controlPage].filter(([, result]) => result !== true).map(([name]) => name)

    show('a control run of the unchanged code passes every check the mutants name', wrong.length === 0 ? true : `fails ${wrong.join('; ')}`)
  }

  console.log(`\n${total - failures} of ${total} checks passed${skipped ? ` (${skipped} skipped: the owner's saves are not here)` : ''}`)
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
