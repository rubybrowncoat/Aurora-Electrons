/*
  Checks the Finances page's reconciliation of the treasury with the wealth log (utilities/treasury-anchors.js): between two recorded snapshots of one race, the stored change of the treasury is the logged net of the cycles between them plus a residual, the part the log does not hold. A snapshot counts only when it carries the witness the recorder stored with it (the increment count and the chained digest of the ledger it was taken on) and the open save's own ledger, digested up to that count, reproduces it.

  node scripts/check-finances-anchors.js [--no-mutations]

  Groups:
  - worked: the reconciliation on small synthetic ledgers, logs and snapshots with known answers: the residual's sign and size, the window's two ends, the coverage, the total, a residual of 0 only when the log accounts for the whole change, and an unknown residual (never 0) for a snapshot whose witness the open save's ledger does not reproduce (checked at the snapshot's own increment count, never at a checkpoint below it), one taken after more increments than the save holds, one with no witness, one without a treasury or after the open save, and a log that starts late, is empty, holds no cycle between the snapshots or lacks an amount; the grouped SQL of the log on an in-memory database; how a residual is printed;
  - lifecycle: the history files the real recorder, `settle` and `attach` leave behind (a rewound replay that diverges inside the last partial checkpoint and then the original reopened, a legacy history attached to an observed campaign, a campaign merged into another), reconciled against the reopened save's own ledger: a snapshot of another history is never compared;
  - mutations: each deliberate breakage of the sources (a residual folded into the net, the witness not compared, a snapshot with no witness let through, the recorder storing none or the wrong count, a merge re-stamping the witness, the old rounding of a residual and more) is applied to a copy of the utilities and must make the checks named for it fail.

  Everything runs on in-memory stores and databases. Any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const sqlite3 = require('sqlite3')
const { loadUtilities } = require('./lib/utilities')
const { kindOf, isSubjectThrow } = require('./lib/fault-credit')
const { mutating, refusePlanting } = require('./lib/no-mutations')

const repo = path.resolve(__dirname, '..')
const src = path.join(repo, 'src')

const STUBS = {
  'electron-store': 'export default class Config { get store() { return {} } set store(value) {} update(change) { this.store = change(this.store) } }',
  dayjs: 'const dayjs = () => ({}); dayjs.extend = () => {}; export default dayjs',
  'dayjs/plugin/utc.js': 'export default {}',
  romanum: 'export default { toNumeral: String }',
  'lodash/partition': 'export default (list, test) => list.reduce((parts, item) => { parts[test(item) ? 0 : 1].push(item); return parts }, [[], []])',
}

const NAMES = ['finances', 'treasury-anchors', 'provenance', 'history', 'campaign', 'campaign-attach']

const loadModules = async (base) => {
  const loaded = await loadUtilities(NAMES.map((name) => `renderer/utilities/${name}`), { stubs: STUBS, directory: base })
  const of = (name) => loaded[`renderer/utilities/${name}`]

  return { anchors: of('treasury-anchors'), provenance: of('provenance'), history: of('history'), campaign: of('campaign'), attach: of('campaign-attach') }
}

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const DAY = 86400

// ---- Worked fixtures ---------------------------------------------------------------------------------------------------

const cycle = (t, net, extra = {}) => ({ t, net, rows: 2, amounts: 2, unmatched: 0, ...extra })

// A log with a cycle every 100 s: its nets are +10, +50, -20, +10, +5, -8 at 0, 100, 200, 300, 400, 500.
const LOG = [cycle(0, 10), cycle(100, 50), cycle(200, -20), cycle(300, 10), cycle(400, 5), cycle(500, -8)]

// The open save's ledger: five increments, one every 100 s, and a replay of it that differs from the second increment on.
const LEDGER_ROWS = Array.from({ length: 5 }, (_, index) => ({ IncrementID: index + 1, GameTime: (index + 1) * 100, Length: 100 }))
const OTHER_ROWS = LEDGER_ROWS.map((row) => (row.IncrementID > 1 ? { ...row, GameTime: row.GameTime + 1 } : row))

// A longer ledger, one increment every 100 s, and a replay that differs after its 90th increment: both agree at the checkpoint of 64 increments.
const LONG_ROWS = Array.from({ length: 130 }, (_, index) => ({ IncrementID: index + 1, GameTime: (index + 1) * 100, Length: 100 }))
const REPLAY_ROWS = LONG_ROWS.map((row) => (row.IncrementID > 90 ? { ...row, GameTime: row.GameTime + 1 } : row))

const UNKNOWN_KEYS = ['from', 'to', 'days', 'status', 'reason', 'storedChange', 'loggedNet', 'residual', 'balanced', 'cycles', 'coverage', 'result']

// ---- Helpers -----------------------------------------------------------------------------------------------------------

const rowsOf = (handle, sql) => new Promise((resolve, reject) => handle.all(sql, (error, rows) => (error ? reject(error) : resolve(rows))))

const installation = () => {
  const files = new Map()
  let counter = 0
  let clock = 1000000
  const store = (name) => ({
    get store() {
      return clone(files.get(name)) || {}
    },
    set store(value) {
      files.set(name, clone(value))
    },
    update(change) {
      const next = change(this.store)

      this.store = next

      return next
    },
  })

  return { files, newId: () => `c${++counter}`, now: () => ++clock, io: { registry: store('registry'), migration: store('migration'), settings: store('settings'), file: (name) => store(`file:${name}`) } }
}

// The chained digest, with each increment's Length, of the first `n` rows of a ledger, made again here from the raw rows with the digest of campaign.js (not its ledger scan).
const chainOracle = (m, rows, n) => rows.slice(0, n).reduce((digest, row) => m.campaign.hashText(`${digest}${row.IncrementID}:${row.GameTime}:${row.Length};`), '')

// ---- A save of one game for the real recorder --------------------------------------------------------------------------

// The ledger's row `i` has IncrementID `i`, a Length of 5 s (or the one `lengths` gives it) and a game time of `i * 5` shifted by the `template` of the campaign (two campaigns never share a ledger) and, after the point `fork.at`, by `fork.salt` (a save replayed from there). The anchor is ten systems whose ages depend on the template.
const mockSave = ({ GameID = 1, name = 'Campaign', template = 1, n, fork = null, races = [7], lengths = {} }) => {
  const ledger = Array.from({ length: n }, (_, index) => {
    const id = index + 1

    return { IncrementID: id, GameTime: id * 5 + template * 1000003 + (fork && id > fork.at ? fork.salt : 0), Length: lengths[id] === undefined ? 5 : lengths[id] }
  })
  const t = n ? ledger[n - 1].GameTime : template * 1000003
  const anchor = Array.from({ length: 10 }, (_, index) => ({ SystemID: 100 + index, SystemNumber: index + 1, Age: Number((1 + template / 100 + index / 1000).toFixed(4)), AbundanceModifier: 1, Stars: 1, DustDensity: 1, SystemTypeID: 1 }))

  return {
    GameID,
    t,
    ledger,
    transaction: (work) => work({ id: 'transaction' }),
    query: async (sql) => {
      if (sql.startsWith('select FCT_Race.GameID')) {
        return [races.map((RaceID) => ({ GameID, RaceID, NPR: 0, SpecialNPRID: 0 }))]
      }

      if (sql.startsWith('select FCT_Game.GameID')) {
        return [[{ GameID, GameName: name, GameTime: t }]]
      }

      if (sql.startsWith('select FCT_System.SystemID')) {
        return [anchor]
      }

      if (sql.startsWith('select FCT_Increments.IncrementID')) {
        return [ledger]
      }

      if (sql.startsWith('select FCT_Game.GameTime')) {
        return [[{ GameTime: t, GameName: name, RaceTitle: 'Race', WealthPoints: 0, AnnualWealth: 0 }]]
      }

      if (sql.startsWith('select (select case when count(FCT_TechSystem')) {
        return [[{ Research: 0, Systems: 0, Commanders: 0 }]]
      }

      return [[]]
    },
  }
}

// ---- The suite ---------------------------------------------------------------------------------------------------------

const defineSuite = (m) => {
  const cases = []
  const { assert } = require('./lib/fault-credit')
  const test = (group, name, run) => cases.push({ group, name, run })
  const near = (actual, expected, message, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`)
  const statuses = (check) => check.windows.map((window) => window.status)

  // A snapshot at `t` taken on a ledger `rows` after `n` increments (by default the one whose increments are 100 s apart, so its count is t / 100), with the witness the recorder would store, or none (`chain: null`).
  const snap = (t, wealth, { rows = LEDGER_ROWS, n = t / 100, chain } = {}) => ({ t, wealth, chain: chain === undefined ? { n, digest: m.campaign.scanLedger(rows.slice(0, n)).lengthDigest } : chain })

  // Snapshots at 100 (1000) and 300 (1060), and the open save at 500 (1050): over (100, 300] the stored change is +60 against a logged net of -10, so the residual is +70; over (300, 500] it is -10 against -3, so -7.
  const RECORDED = [snap(100, 1000), snap(300, 1060)]
  const LIVE = { t: 500, wealth: 1050 }

  const reconcile = (overrides = {}) => {
    const { rows = LEDGER_ROWS, ...rest } = overrides
    const anchors = rest.anchors || RECORDED

    return m.anchors.reconcileTreasury({ settled: true, anchors, live: LIVE, log: LOG, ledger: m.anchors.ledgerEvidence(rows, anchors), ...rest })
  }

  // ---- worked ----
  test('worked', 'the residual is the stored change less the logged net, with its sign and size', () => {
    const { windows } = reconcile()

    assert.equal(windows.length, 2)
    assert.deepEqual(windows.map((window) => [window.from, window.to, window.status]), [[100, 300, 'known'], [300, 500, 'known']])
    assert.deepEqual([windows[0].storedChange, windows[0].loggedNet, windows[0].residual], [60, -10, 70])
    assert.deepEqual([windows[1].storedChange, windows[1].loggedNet, windows[1].residual], [-10, -3, -7])
    windows.forEach((window) => assert.equal(window.storedChange, window.loggedNet + window.residual))
    assert.equal(windows[0].result.value, 70)
    assert.equal(windows[1].result.value, -7)
  })

  test('worked', 'the log window is after the earlier snapshot and up to the later one: a cycle at the earlier time is out, one at the later time is in', () => {
    const [first, second] = reconcile().windows

    assert.equal(first.cycles, 2, 'the window (100, 300] holds the cycles at 200 and 300')
    assert.equal(first.loggedNet, -10)
    assert.equal(second.cycles, 2, 'the window (300, 500] holds the cycles at 400 and 500')
    assert.equal(second.loggedNet, -3)
  })

  test('worked', 'a window\'s cycles stop at its later snapshot even when the log holds more', () => {
    const longer = [...LOG, cycle(600, 1000), cycle(700, 1000)]
    const [first, second] = reconcile({ log: longer }).windows

    assert.equal(first.loggedNet, -10)
    assert.equal(second.loggedNet, -3)
    assert.equal(second.cycles, 2)
  })

  test('worked', 'the coverage states the cycles, the days, the last logged time and the span after it that holds no logged cycle', () => {
    const [first] = reconcile().windows
    const [, second] = reconcile({ live: { t: 520, wealth: 1050 } }).windows

    assert.deepEqual(first.coverage, { cycles: 2, days: 200 / DAY, loggedThrough: 300, unloggedTail: 0 })
    assert.deepEqual(second.coverage, { cycles: 2, days: 220 / DAY, loggedThrough: 500, unloggedTail: 20 / DAY })
  })

  test('worked', 'the whole span is the windows added up, and only when every window is known', () => {
    const check = reconcile()

    assert.deepEqual([check.total.storedChange, check.total.loggedNet, check.total.residual, check.total.cycles, check.total.windows], [50, -13, 63, 4, 2])
    assert.deepEqual([check.total.from, check.total.to], [100, 500])
    assert.equal(check.total.storedChange, check.total.loggedNet + check.total.residual)

    const split = reconcile({ anchors: [...RECORDED, snap(400, 1055, { rows: OTHER_ROWS })] })

    assert.equal(split.total, null)
    assert.equal(reconcile({ anchors: [RECORDED[1]] }).total, null, 'a single window has no separate total')
  })

  test('worked', 'a residual is 0 only when the log accounts for the whole stored change', () => {
    const exact = reconcile({ live: { t: 500, wealth: 1057 } }).windows[1]
    const near1 = reconcile({ live: { t: 500, wealth: 1057.01 } }).windows[1]
    const noise = reconcile({ live: { t: 500, wealth: 1057 + 1e-9 } }).windows[1]
    const under = reconcile({ live: { t: 500, wealth: 1056.99 } }).windows[1]

    assert.deepEqual([exact.residual, exact.balanced], [0, true])
    assert.deepEqual([noise.residual, noise.balanced], [0, true], 'float noise from adding many amounts balances')
    assert.equal(near1.balanced, false)
    near(near1.residual, 0.01, 'a residual of one hundredth is not 0')
    assert.notEqual(near1.residual, 0)
    near(under.residual, -0.01, 'a shortfall of one hundredth is not 0')
    assert.notEqual(under.residual, 0)
  })

  test('worked', 'a residual is printed as 0 only when it is exactly 0, and one under 1 never reads as 0', () => {
    const signed = (value) => `${value < 0 ? '−' : '+'}${Math.round(Math.abs(value))}`
    const label = (value) => m.anchors.residualLabel(value, signed)

    assert.equal(label(0), '0')
    assert.equal(label(null), '—')
    assert.equal(label(NaN), '—')
    assert.equal(label(-0.0000999984), '−0.0001')
    assert.equal(label(0.0001), '+0.0001')
    assert.equal(label(0.00123), '+0.0012')
    assert.equal(label(-0.5), '−0.5')
    assert.equal(label(0.00000123), '+0.0000012')
    assert.equal(label(-1234.4), '−1234')
    assert.equal(label(70), '+70')

    ;[1.0000001e-6, 0.00000999, -0.0000999984, 0.0001, 0.0004, -0.0049, 0.01, 0.2, -0.4999, 0.9999, -0.5, 1.4].forEach((value) => {
      const text = label(value)

      assert.ok(!/^[−+]?0$/.test(text), `${value} prints as ${text}`)
      assert.ok(Number(text.replace('−', '-')) !== 0, `${value} prints as ${text}`)
    })

    const tiny = reconcile({ live: { t: 500, wealth: 1057 + 0.0001 } }).windows[1]

    assert.equal(tiny.balanced, false)
    assert.equal(label(tiny.residual), '+0.0001', 'the window that does not balance by a ten-thousandth')
    assert.equal(label(reconcile({ live: { t: 500, wealth: 1057 } }).windows[1].residual), '0', 'the window that balances prints exactly 0')
  })

  test('worked', 'a window with an unknown residual is never 0, and says why', () => {
    const cases = [
      reconcile({ anchors: [snap(100, 1000), snap(200, 5000, { rows: OTHER_ROWS }), snap(300, 1060)] }),
      reconcile({ anchors: [snap(100, null), snap(300, 1060)] }),
      reconcile({ anchors: [snap(100, 1000, { chain: null }), snap(300, 1060)] }),
      reconcile({ ledger: null }),
      reconcile({ log: LOG.filter((entry) => entry.t > 150) }),
      reconcile({ log: [] }),
    ]

    cases.forEach((check) => {
      const unknown = check.windows.filter((window) => window.status === 'unknown')

      assert.ok(unknown.length > 0)
      unknown.forEach((window) => {
        assert.equal(window.residual, null)
        assert.equal(window.storedChange, null)
        assert.equal(window.loggedNet, null)
        assert.equal(window.balanced, false)
        assert.equal(window.coverage, null)
        assert.ok(window.reason.length > 10)
        assert.equal(window.result.status, 'unavailable')
        assert.equal(window.result.value, null)
        assert.ok(window.result.inputs.missing.includes(window.reason))
      })
    })
  })

  test('worked', 'a snapshot whose witness the open save\'s ledger does not reproduce is refused, and no window spans it', () => {
    const check = reconcile({ anchors: [snap(100, 1000), snap(200, 5000, { rows: OTHER_ROWS }), snap(300, 1060)] })

    assert.deepEqual(check.windows.map((window) => [window.from, window.to, window.status]), [[100, 200, 'unknown'], [200, 300, 'unknown'], [300, 500, 'known']])
    assert.ok(/different ledger/.test(check.windows[0].reason))
    assert.ok(!check.windows.some((window) => window.from === 100 && window.to === 300), 'a balance across the snapshot of another ledger')
    assert.equal(check.total, null)

    const increments = reconcile({ anchors: [snap(100, 1000), snap(250, 5000, { n: 7, rows: [...LEDGER_ROWS, { IncrementID: 6, GameTime: 600 }, { IncrementID: 7, GameTime: 700 }] }), snap(300, 1060)] })

    assert.deepEqual(statuses(increments), ['unknown', 'unknown', 'known'])
    assert.ok(/more increments/.test(increments.windows[0].reason), 'taken after more increments than the open save holds')
  })

  test('worked', 'a snapshot is verified at its own increment count, never at a checkpoint below it', () => {
    const live = { t: 13000, wealth: 1000 }
    const log = Array.from({ length: 130 }, (_, index) => cycle((index + 1) * 100, 1))
    const run = (anchors) => reconcile({ anchors, rows: LONG_ROWS, live, log })
    const honest = run([snap(7000, 500, { rows: LONG_ROWS, n: 70 }), snap(10000, 800, { rows: LONG_ROWS, n: 100 })])
    const replayed = run([snap(7000, 500, { rows: LONG_ROWS, n: 70 }), snap(10001, 800, { rows: REPLAY_ROWS, n: 100 })])

    assert.deepEqual(statuses(honest), ['known', 'known'], 'snapshots between checkpoints, on the open save\'s own ledger, are compared')
    assert.deepEqual(statuses(replayed), ['unknown', 'unknown'], 'a replay that differs after the 90th increment agrees with the save at the checkpoint of 64 and is still refused at its own count')
    assert.ok(/different ledger/.test(replayed.windows[0].reason))

    const evidence = m.anchors.ledgerEvidence(LONG_ROWS, [snap(7000, 1, { rows: LONG_ROWS, n: 70 }), snap(10000, 1, { rows: LONG_ROWS, n: 100 }), snap(500, 1, { chain: null })])

    assert.equal(evidence.count, 130)
    assert.deepEqual(Object.keys(evidence.exact).sort(), ['100', '70'], 'the digests at the counts the snapshots were taken at, and no others')
    assert.equal(evidence.exact[70], chainOracle(m, LONG_ROWS, 70))
    assert.equal(evidence.exact[100], chainOracle(m, LONG_ROWS, 100))
  })

  test('worked', 'a snapshot is refused when the open save\'s ledger differs only in the Length of an increment, below a count that is no checkpoint and at the count itself', () => {
    const live = { t: 13000, wealth: 1000 }
    const log = Array.from({ length: 130 }, (_, index) => cycle((index + 1) * 100, 1))
    const run = (rows, anchors) => reconcile({ anchors, rows, live, log })
    const lengthAt = (id) => LONG_ROWS.map((row) => (row.IncrementID === id ? { ...row, Length: 300 } : row))
    const taken = [snap(7000, 500, { rows: LONG_ROWS, n: 70 }), snap(9700, 800, { rows: LONG_ROWS, n: 97 })]

    assert.deepEqual(statuses(run(LONG_ROWS, taken)), ['known', 'known'])

    const below = lengthAt(90)

    assert.equal(m.campaign.scanLedger(below, [97]).exact[97], m.campaign.scanLedger(LONG_ROWS, [97]).exact[97], 'the identity digest cannot see a Length')
    assert.notEqual(m.campaign.scanLedger(below, [97]).exactLength[97], m.campaign.scanLedger(LONG_ROWS, [97]).exactLength[97])
    assert.deepEqual(statuses(run(below, taken)), ['unknown', 'unknown'], 'a Length that differs at increment 90 refuses the snapshot taken after 97')
    assert.ok(/different ledger/.test(run(below, taken).windows[0].reason))
    assert.deepEqual(statuses(run(below, [taken[0]])), ['known'], 'the snapshot taken after 70 increments is still on the ledger')

    const parting = lengthAt(97)

    assert.deepEqual(statuses(run(parting, taken)), ['unknown', 'unknown'], 'a Length that differs at increment 97 itself refuses the snapshot taken after 97')
    assert.deepEqual(statuses(run(parting, [snap(9600, 700, { rows: LONG_ROWS, n: 96 })])), ['known'], 'and not the one taken after 96')
  })

  test('worked', 'the ledger read holds the Length of every increment, so two ledgers that differ only in a Length give different witnesses', async () => {
    const db = new sqlite3.Database(':memory:')
    const run = (sql) => new Promise((resolve, reject) => db.run(sql, (error) => (error ? reject(error) : resolve())))

    try {
      await run('create table FCT_Increments (IncrementID integer, GameID integer, GameTime integer, Length integer)')

      for (let id = 1; id <= 100; id++) {
        await run(`insert into FCT_Increments values (${id}, 1, ${id * 5}, 5), (${1000 + id}, 2, ${id * 5}, ${id === 97 ? 300 : 5})`)
      }

      const first = await rowsOf(db, m.campaign.ledgerSql(1))
      const second = await rowsOf(db, m.campaign.ledgerSql(2))

      assert.equal(first.length, 100)
      assert.deepEqual(first[96], { IncrementID: 97, GameTime: 485, Length: 5 })
      assert.deepEqual(second[96], { IncrementID: 1097, GameTime: 485, Length: 300 })

      const same = (rows) => rows.map((row) => ({ ...row, IncrementID: row.IncrementID % 1000 }))
      const anchor = { t: 500, wealth: 1, chain: { n: 100, digest: m.campaign.scanLedger(same(first), [100]).exactLength[100] } }

      assert.equal(m.anchors.ledgerEvidence(same(first), [anchor]).exact[100], anchor.chain.digest)
      assert.notEqual(m.anchors.ledgerEvidence(same(second), [anchor]).exact[100], anchor.chain.digest)
    } finally {
      db.close()
    }
  })

  test('worked', 'a snapshot recorded without a witness, or with a malformed one, is refused as not verified', () => {
    const none = reconcile({ anchors: [snap(100, 1000, { chain: null }), snap(300, 1060)] })

    if (process.argv.includes('--detail')) {
      console.log('VALUE treasury statuses without a witness:', JSON.stringify(statuses(none)))
    }
    assert.deepEqual(statuses(none), ['unknown', 'known'])
    assert.ok(/recorded before/.test(none.windows[0].reason))

    const malformed = [{ n: 0, digest: '0123456789abcdef' }, { n: 1.5, digest: '0123456789abcdef' }, { n: 2, digest: 'xyz' }, { n: 2 }, { digest: '0123456789abcdef' }, 'text', [2, '0123456789abcdef'], null]
    const recorded = m.anchors.recordedAnchors({ snapshots: malformed.map((chain, index) => ({ t: 100 + index, wealth: 1, chain })) })

    assert.equal(recorded.length, malformed.length)
    assert.ok(recorded.every((anchor) => anchor.chain === null), 'a witness that is not a count and a 16-digit digest is no witness')
    assert.deepEqual(m.anchors.recordedAnchors({ snapshots: [{ t: 100, wealth: 1, chain: { n: 2, digest: '0123456789abcdef', extra: 1 } }] })[0].chain, { n: 2, digest: '0123456789abcdef' })
    assert.deepEqual(statuses(reconcile({ anchors: recorded.slice(0, 2) })), ['unknown', 'unknown'])
  })

  test('worked', 'a snapshot with no treasury is unknown, not a treasury of 0', () => {
    const check = reconcile({ anchors: [snap(100, 1000), snap(200, null), snap(300, 1060)] })

    assert.deepEqual(check.windows.map((window) => [window.status, window.residual]), [['unknown', null], ['unknown', null], ['known', -7]])
    assert.ok(/no treasury/.test(check.windows[0].reason))

    const recorded = m.anchors.recordedAnchors({ snapshots: [{ t: 100, wealth: 1000 }, { t: 200, wealth: null }, { t: 250 }, { wealth: 5 }, { t: 300, wealth: 1060 }] })

    assert.deepEqual(recorded.map((anchor) => [anchor.t, anchor.wealth, anchor.chain]), [[100, 1000, null], [200, null, null], [250, null, null], [300, 1060, null]])
  })

  test('worked', 'a snapshot after the open save is refused although the log holds cycles after it', () => {
    const log = [...LOG, cycle(600, 25), cycle(700, 25)]
    const check = reconcile({ anchors: [...RECORDED, snap(700, 9999, { n: 5 })], log })
    const last = check.windows[check.windows.length - 1]

    assert.deepEqual([last.from, last.to, last.status, last.residual], [500, 700, 'unknown', null])
    assert.ok(/later than the open save/.test(last.reason))
  })

  test('worked', 'a save that holds fewer increments than a snapshot was taken after refuses it, and compares the ones it holds', () => {
    const rewound = LEDGER_ROWS.slice(0, 3)
    const live = { t: 300, wealth: 1060 }
    const check = reconcile({ anchors: [snap(100, 1000), snap(250, 900, { n: 4 }), snap(400, 1100, { n: 4 })], rows: rewound, live })

    assert.deepEqual(statuses(check), ['unknown', 'unknown', 'unknown'])
    assert.ok(/more increments/.test(check.windows[0].reason))
    assert.ok(/later than the open save/.test(check.windows[2].reason))
    assert.deepEqual(statuses(reconcile({ anchors: [snap(100, 1000)], rows: rewound, live })), ['known'], 'the snapshot at the first increment is on the shorter ledger too')
  })

  test('worked', 'a snapshot is not verified when the open save\'s ledger is not read, and an empty ledger verifies nothing', () => {
    if (process.argv.includes('--detail')) {
      console.log('VALUE treasury statuses without a ledger:', JSON.stringify(statuses(reconcile({ ledger: null }))))
    }
    assert.deepEqual(statuses(reconcile({ ledger: null })), ['unknown', 'unknown'])
    assert.ok(/not read/.test(reconcile({ ledger: null }).windows[0].reason))
    assert.deepEqual(statuses(reconcile({ rows: [] })), ['unknown', 'unknown'])
  })

  test('worked', 'a log that starts after the earlier snapshot, is empty, holds no cycle between the snapshots or lacks an amount does not cover the span', () => {
    const late = reconcile({ log: LOG.filter((entry) => entry.t >= 150) })

    assert.deepEqual(statuses(late), ['unknown', 'known'], 'the window from 100 is not covered, the one from 300 is')
    assert.ok(/starts after/.test(late.windows[0].reason))

    const empty = reconcile({ log: [] })

    assert.deepEqual(statuses(empty), ['unknown', 'unknown'])

    const quiet = reconcile({ anchors: [snap(300, 1060)], live: { t: 350, wealth: 1060 } })

    assert.equal(quiet.windows[0].status, 'unknown')
    assert.ok(/no cycle/.test(quiet.windows[0].reason))

    const gap = reconcile({ log: LOG.map((entry) => (entry.t === 300 ? cycle(300, 10, { amounts: 1 }) : entry)) })

    assert.deepEqual(statuses(gap), ['unknown', 'known'], 'the cycle at 300 is in (100, 300] and not in (300, 500]')
  })

  test('worked', 'a log cycle with no net is unknown', () => {
    const gap = reconcile({ log: LOG.map((entry) => (entry.t === 400 ? cycle(400, null) : entry)) })

    assert.deepEqual(statuses(gap), ['known', 'unknown'])
  })

  test('worked', 'the open save\'s own treasury is the last anchor and replaces a snapshot at its time', () => {
    const check = reconcile({ anchors: [...RECORDED, snap(500, 1234)] })

    assert.equal(check.windows.length, 2)
    assert.equal(check.windows[1].storedChange, -10, 'the snapshot at 500 is the live treasury, not a second anchor')
  })

  test('worked', 'nothing is compared without a settled campaign, a stored treasury or an earlier snapshot, and the reason says which', () => {
    const unsettled = reconcile({ settled: false })

    assert.deepEqual([unsettled.windows.length, unsettled.total], [0, null])
    assert.ok(/not settled/.test(unsettled.reason))
    assert.ok(/no treasury/.test(reconcile({ live: { t: 500, wealth: null } }).reason))
    assert.ok(/No earlier snapshot/.test(reconcile({ anchors: [] }).reason))
    assert.ok(/No earlier snapshot/.test(reconcile({ anchors: [snap(500, 1)] }).reason))
  })

  test('worked', 'a use missing from the use table is counted as spending, with the assumption stated', () => {
    const plain = reconcile().windows[0].result
    const odd = reconcile({ log: LOG.map((entry) => (entry.t === 200 ? cycle(200, -20, { unmatched: 1 }) : entry)) }).windows[0].result

    assert.deepEqual(plain.assumptions.filter((line) => /use table/.test(line)), [])
    assert.ok(odd.assumptions.some((line) => /use table/.test(line)))
    assert.equal(odd.status, 'estimated')
    assert.equal(plain.status, 'estimated')
  })

  test('worked', 'a window names no cause for its residual: its fields are the documented ones', () => {
    const [known1] = reconcile().windows
    const [blocked] = reconcile({ anchors: [snap(100, null)] }).windows

    assert.deepEqual(Object.keys(known1).sort(), [...UNKNOWN_KEYS].sort())
    assert.deepEqual(Object.keys(blocked).sort(), [...UNKNOWN_KEYS].sort())
  })

  test('worked', 'the log read sums income less spending by the use\'s flag, counts a use missing from the table as spending, and flags a missing amount', async () => {
    const db = new sqlite3.Database(':memory:')
    const run = (sql) => new Promise((resolve, reject) => db.run(sql, (error) => (error ? reject(error) : resolve())))

    try {
      await run('create table DIM_WealthUse (WealthUseID integer, Description text, Income integer)')
      await run('create table FCT_WealthData (GameID integer, RaceID integer, UseID integer, TimeUsed integer, Amount real)')
      await run("insert into DIM_WealthUse values (1, 'Taxes', 1), (2, 'Upkeep', 0)")
      await run('insert into FCT_WealthData values (9, 5, 1, 100, 40), (9, 5, 2, 100, 15), (9, 5, 99, 100, 5), (9, 5, 1, 200, 10), (9, 5, 2, 200, null), (9, 6, 1, 100, 1000), (8, 5, 1, 100, 1000)')

      const rows = await rowsOf(db, m.anchors.wealthLogSql(9, 5))

      assert.deepEqual(rows, [{ t: 100, net: 20, rows: 3, amounts: 3, unmatched: 1 }, { t: 200, net: 10, rows: 2, amounts: 1, unmatched: 0 }])
      assert.throws(() => m.anchors.wealthLogSql('9 or 1=1', 5), /whole number/)

      const anchors = [snap(100, 100, { n: 1 })]
      const check = m.anchors.reconcileTreasury({ settled: true, anchors, live: { t: 200, wealth: 130 }, log: rows, ledger: m.anchors.ledgerEvidence(LEDGER_ROWS, anchors) })

      assert.equal(check.windows[0].status, 'unknown', 'the cycle at 200 lacks an amount')
    } finally {
      db.close()
    }
  })

  // ---- lifecycle ----
  const play = async (inst, save, file = 'a.db') => {
    let resolution = null
    const run = await m.history.recordHistory(save, { storage: inst.io, path: file, newId: inst.newId, now: inst.now, onResolved: (_GameID, resolved) => { resolution = resolved } })

    if (run.failed.length) {
      throw run.failed[0].error
    }

    return resolution
  }
  const snapshotsOf = (inst, resolution) => (clone(inst.files.get(`file:campaign-${resolution.campaignId}-${resolution.branchId}`)).races[7].snapshots)
  const lifecycleCheck = (inst, resolution, save, log) => {
    const anchors = m.anchors.recordedAnchors({ snapshots: snapshotsOf(inst, resolution) })

    return { anchors, check: m.anchors.reconcileTreasury({ settled: true, anchors, live: { t: save.t, wealth: 0 }, log, ledger: m.anchors.ledgerEvidence(save.ledger, anchors) }) }
  }

  test('lifecycle', 'the recorder stores with each snapshot the increment count and chained digest of the ledger it read', async () => {
    const inst = installation()
    const save = mockSave({ n: 130 })
    const resolution = await play(inst, save)
    const [snapshot] = snapshotsOf(inst, resolution)

    assert.deepEqual(snapshot.chain, { n: 130, digest: chainOracle(m, save.ledger, 130) })

    const grown = mockSave({ n: 131 })
    const again = await play(inst, grown)
    const anchors = m.anchors.recordedAnchors({ snapshots: snapshotsOf(inst, again) })
    const check = m.anchors.reconcileTreasury({ settled: true, anchors, live: { t: grown.t, wealth: 0 }, log: [cycle(1000100, 0), cycle(grown.t, 0)], ledger: m.anchors.ledgerEvidence(grown.ledger, anchors) })

    assert.deepEqual(check.windows.map((window) => [window.from, window.to, window.status, window.residual]), [[save.t, grown.t, 'known', 0]], 'the same ledger grown by an increment is compared')
  })

  test('lifecycle', 'a rewound replay that diverges inside the last partial checkpoint joins the branch, and the original reopened never compares its snapshot', async () => {
    const inst = installation()
    const original = mockSave({ n: 200 })
    const replay = mockSave({ n: 199, fork: { at: 195, salt: 1 } })
    const first = await play(inst, original)
    const second = await play(inst, replay)
    const third = await play(inst, original)

    assert.deepEqual([first.relation, second.relation, third.relation], ['new', 'rewound', 'same'], 'the hazard: the replay is joined to the branch as a rewound save and the original is the same save again')
    assert.deepEqual([second.campaignId, second.branchId], [first.campaignId, first.branchId])

    const log = [cycle(1000000, 0), cycle(original.t, 0)]
    const { anchors, check } = lifecycleCheck(inst, third, original, log)

    assert.deepEqual(anchors.map((anchor) => anchor.t), [replay.t, original.t], 'both snapshots are in the branch')
    assert.deepEqual(check.windows.map((window) => [window.from, window.to, window.status, window.residual]), [[replay.t, original.t, 'unknown', null]])
    assert.ok(/different ledger/.test(check.windows[0].reason))

    const reopened = lifecycleCheck(inst, second, replay, [cycle(1000000, 0), cycle(replay.t, 0)])

    assert.deepEqual(reopened.check.windows.map((window) => [window.from, window.to, window.status, window.residual]), [[replay.t, original.t, 'unknown', null]], 'with the replay open, the original\'s snapshot is later than the open save')
  })

  test('lifecycle', 'a replay that parts at an increment with the same ID and game time and only another Length joins the branch as a continuation, and the snapshot taken before it is refused', async () => {
    const inst = installation()
    const before = mockSave({ n: 97, lengths: { 97: 300 } })
    const after = mockSave({ n: 120, lengths: { 97: 120 } })
    const first = await play(inst, before)
    const second = await play(inst, after)

    assert.equal(second.relation, 'continues', 'the hazard: the identity digest cannot see the difference, so the longer save continues the branch')
    assert.deepEqual([second.campaignId, second.branchId], [first.campaignId, first.branchId])

    const { anchors, check } = lifecycleCheck(inst, second, after, [cycle(1000000, 0), cycle(after.t, 0)])

    assert.deepEqual(anchors.map((anchor) => anchor.t), [before.t, after.t])
    assert.equal(anchors[0].chain.n, 97)
    assert.notEqual(anchors[0].chain.digest, chainOracle(m, after.ledger, 97), 'the witness holds the Length the earlier save had')
    assert.deepEqual(check.windows.map((window) => [window.from, window.to, window.status, window.residual]), [[before.t, after.t, 'unknown', null]])
    assert.ok(/different ledger/.test(check.windows[0].reason))

    const grown = mockSave({ n: 130, lengths: { 97: 120 } })
    const third = await play(inst, grown)
    const later = lifecycleCheck(inst, third, grown, [cycle(1000000, 0), cycle(grown.t, 0)])

    assert.deepEqual(later.check.windows.map((window) => [window.from, window.to, window.status, window.residual]), [[before.t, after.t, 'unknown', null], [after.t, grown.t, 'known', 0]], 'the snapshot taken on the ledger the open save grew from is compared')
  })

  test('lifecycle', 'a legacy history attached to an observed campaign is not compared with the save, whatever the campaign\'s record says', async () => {
    const inst = installation()
    const original = mockSave({ n: 200 })

    inst.files.set('file:game-1', { gameName: 'Different campaign', races: { 7: { raceName: 'Race', npr: false, snapshots: [{ t: 1000100, wealth: 0 }] } }, intel: {} })

    const first = await play(inst, original)
    const pool = Object.keys(inst.files.get('registry').pool || {})[0]

    assert.ok(pool, 'the legacy history waits unattached in the pool')
    m.attach.attach(inst.io, { from: { poolId: pool }, to: { campaignId: first.campaignId, branchId: 'b1' } })

    const again = await play(inst, original)

    assert.equal(again.relation, 'same', 'the hazard: after the attach the save is the same campaign again')

    const { anchors, check } = lifecycleCheck(inst, again, original, [cycle(1000000, 0), cycle(original.t, 0)])

    assert.deepEqual(anchors.map((anchor) => [anchor.t, anchor.chain === null]), [[1000100, true], [original.t, false]])
    assert.deepEqual(check.windows.map((window) => [window.from, window.to, window.status, window.residual]), [[1000100, original.t, 'unknown', null]])
    assert.ok(/recorded before/.test(check.windows[0].reason))
  })

  test('lifecycle', 'a campaign merged into another keeps each snapshot\'s own witness: the other ledger\'s snapshot is refused and the one on this save\'s ledger is compared', async () => {
    const inst = installation()
    const first = await play(inst, mockSave({ n: 40 }), 'a.db')
    const other = mockSave({ n: 41, fork: { at: 32, salt: 1 } })
    const second = await play(inst, other, 'b.db')

    assert.notEqual(second.campaignId, first.campaignId, 'the second save starts a campaign of its own')
    m.attach.attach(inst.io, { from: { campaignId: second.campaignId }, to: { campaignId: first.campaignId, branchId: 'b1' } })

    const grown = mockSave({ n: 100, fork: { at: 32, salt: 1 } })

    await play(inst, grown, 'b.db')

    const again = await play(inst, grown, 'b.db')
    const { anchors, check } = lifecycleCheck(inst, again, grown, [cycle(1000100, 0), cycle(1000400, 0), cycle(grown.t, 0)])
    const own = anchors.filter((anchor) => anchor.t === first.t || anchor.chain)

    assert.ok(own.length >= 3, `the merged branch holds ${anchors.length} snapshots`)

    const refused = check.windows.filter((window) => window.status === 'unknown')
    const compared = check.windows.filter((window) => window.status === 'known')

    assert.ok(refused.length > 0 && refused.every((window) => /different ledger/.test(window.reason)), JSON.stringify(check.windows.map((window) => [window.from, window.to, window.status, window.reason])))
    assert.ok(compared.some((window) => window.from === other.t && window.to === grown.t), 'the merged snapshot that is on the open save\'s ledger is compared')
    assert.equal(check.total, null)
  })

  return cases
}

// ---- Mutations ---------------------------------------------------------------------------------------------------------

const SIGN = 'worked: the residual is the stored change less the logged net'
const ENDS = 'worked: the log window is after the earlier snapshot'
const UNKNOWN = 'worked: a window with an unknown residual is never 0'
const OTHER_LEDGER = 'worked: a snapshot whose witness'
const OWN_COUNT = 'worked: a snapshot is verified at its own increment count'
const NO_WITNESS = 'worked: a snapshot recorded without a witness'
const NO_TREASURY = 'worked: a snapshot with no treasury is unknown'
const ZERO = 'worked: a residual is 0 only when'
const PRINTED = 'worked: a residual is printed as 0 only when'
const LOG_READ = 'worked: the log read sums'
const REWIND_LIFE = 'lifecycle: a rewound replay'
const LEGACY_LIFE = 'lifecycle: a legacy history attached'
const MERGE_LIFE = 'lifecycle: a campaign merged into another'
const RECORDED_LIFE = 'lifecycle: the recorder stores with each snapshot'
const LENGTH_ONLY = 'worked: a snapshot is refused when the open save\'s ledger differs only in the Length'
const SQL_LENGTH = 'worked: the ledger read holds the Length'
const LENGTH_LIFE = 'lifecycle: a replay that parts at an increment'

// `from` must occur once in `file` (a utility of the copy); `fails` are the starts of the full names ("group: name") of the checks that must fail.
// TFIN-03 catalog audit: zero-based indices and mapped checks are unchanged; replacements do not prove retired operators.
// [3] Old: "a snapshot with no witness is let through"; new: "an unwitnessed snapshot is accepted without verification".
// Original guard removal dereferences anchor.chain.n at treasury-anchors.js:66 before reconciliation returns.
// Replacement class: an unwitnessed anchor is explicitly accepted as known. Original null-chain guard-removal class currently has no credited fault.
// [15] Old: "a snapshot is verified without reading the save's ledger"; new: "a snapshot is accepted without a ledger".
// Original guard removal dereferences ledger.count at treasury-anchors.js:66 before reconciliation returns.
// Replacement class: an anchor is explicitly accepted without a ledger. Original null-ledger guard-removal class currently has no credited fault.

const MUTATIONS = [
  { name: 'the residual is folded into the net', file: 'treasury-anchors.js', from: 'const storedChange = to.wealth - from.wealth\n  const difference', to: 'const storedChange = to.wealth - from.wealth\n  loggedNet = storedChange\n  const difference', fails: [SIGN, ZERO] },
  { name: 'the residual has the wrong sign', file: 'treasury-anchors.js', from: 'const difference = storedChange - loggedNet', to: 'const difference = loggedNet - storedChange', fails: [SIGN] },
  { name: 'the witness is not compared with the open save\'s ledger', file: 'treasury-anchors.js', from: 'if (ledger.exact[anchor.chain.n] !== anchor.chain.digest) {', to: 'if (false) {', fails: [OTHER_LEDGER, OWN_COUNT, REWIND_LIFE, MERGE_LIFE] },
  { name: 'an unwitnessed snapshot is accepted without verification', file: 'treasury-anchors.js', from: 'if (!anchor.chain) {', to: 'if (!anchor.chain) return null\n\n  if (!anchor.chain) {', fails: [NO_WITNESS, LEGACY_LIFE] },
  { name: 'a snapshot taken after more increments than the save holds is not told apart', file: 'treasury-anchors.js', from: 'if (anchor.chain.n > ledger.count) {', to: 'if (false) {', fails: [OTHER_LEDGER, 'worked: a save that holds fewer increments'] },
  { name: 'the witness is read at the checkpoint below the snapshot\'s increment count', file: 'treasury-anchors.js', from: 'anchors.filter((anchor) => anchor.chain).map((anchor) => anchor.chain.n)', to: 'anchors.filter((anchor) => anchor.chain).map((anchor) => Math.floor(anchor.chain.n / 64) * 64)', fails: [OWN_COUNT] },
  { name: 'a malformed witness is kept', file: 'treasury-anchors.js', from: 'chain: isChain(snapshot.chain) ? { n: snapshot.chain.n, digest: snapshot.chain.digest } : null', to: 'chain: snapshot.chain || null', fails: [NO_WITNESS] },
  { name: 'a witness of no increments is believed', file: 'history.js', from: 'Number.isInteger(chain.n) && chain.n > 0', to: 'Number.isInteger(chain.n) && chain.n >= 0', fails: [NO_WITNESS] },
  { name: 'a snapshot without a treasury is recorded as 0', file: 'treasury-anchors.js', from: 'wealth: finite(snapshot.wealth) ? snapshot.wealth : null,', to: 'wealth: finite(snapshot.wealth) ? snapshot.wealth : 0,', fails: [NO_TREASURY] },
  { name: 'a snapshot without a treasury is let through to the arithmetic', file: 'treasury-anchors.js', from: 'if (!finite(anchor.wealth)) {', to: 'if (false) {', fails: [NO_TREASURY, UNKNOWN] },
  { name: 'the log window takes the cycle at the earlier snapshot', file: 'treasury-anchors.js', from: 'firstAfter(log, from.t)', to: 'firstAfter(log, from.t - 1)', fails: [ENDS, SIGN] },
  { name: 'the log window skips the first cycle after the earlier snapshot', file: 'treasury-anchors.js', from: 'firstAfter(log, from.t)', to: 'firstAfter(log, from.t + 100)', fails: [ENDS, SIGN] },
  { name: 'the log window leaves out the cycle at the later snapshot', file: 'treasury-anchors.js', from: 'log[index].t <= to.t', to: 'log[index].t < to.t', fails: [ENDS, SIGN] },
  { name: 'the log window takes a cycle after the later snapshot', file: 'treasury-anchors.js', from: 'log[index].t <= to.t', to: 'log[index].t <= to.t + 100', fails: [ENDS, 'worked: a window\'s cycles stop at its later snapshot'] },
  { name: 'a snapshot after the open save is accepted', file: 'treasury-anchors.js', from: 'if (anchor.t > live.t) {', to: 'if (false) {', fails: ['worked: a snapshot after the open save is refused'] },
  { name: 'a snapshot is accepted without a ledger', file: 'treasury-anchors.js', from: 'if (!ledger || !(ledger.count > 0)) {', to: 'if (!ledger || !(ledger.count > 0)) return null\n\n  if (!ledger || !(ledger.count > 0)) {', fails: ['worked: a snapshot is not verified when the open save\'s ledger is not read'] },
  { name: 'an unknown window reads as a residual of 0', file: 'treasury-anchors.js', from: 'storedChange: null, loggedNet: null, residual: null, balanced: false, cycles: 0, coverage: null, result: unknownResult(reason)', to: 'storedChange: null, loggedNet: null, residual: 0, balanced: false, cycles: 0, coverage: null, result: unknownResult(reason)', fails: [UNKNOWN, NO_TREASURY] },
  { name: 'a residual up to half a unit counts as balanced', file: 'treasury-anchors.js', from: 'export const BALANCE_TOLERANCE = 1e-6', to: 'export const BALANCE_TOLERANCE = 0.5', fails: [ZERO] },
  { name: 'no window is ever balanced', file: 'treasury-anchors.js', from: 'const balanced = Math.abs(difference) <= BALANCE_TOLERANCE\n', to: 'const balanced = false\n', fails: [ZERO] },
  { name: 'a residual under 1 is rounded to the thousandth when printed', file: 'treasury-anchors.js', from: 'String(Number(Math.abs(residual).toPrecision(2)))', to: 'String(Math.round(Math.abs(residual) * 1000) / 1000)', fails: [PRINTED] },
  { name: 'a residual of 0 prints as a signed figure', file: 'treasury-anchors.js', from: 'if (residual === 0) {\n    return \'0\'', to: 'if (residual === 0) {\n    return signed(residual)', fails: [PRINTED] },
  { name: 'a log that starts after the earlier snapshot is compared', file: 'treasury-anchors.js', from: 'if (log[0].t > from.t) {', to: 'if (false) {', fails: ['worked: a log that starts after'] },
  { name: 'a window with no logged cycle is compared', file: 'treasury-anchors.js', from: 'if (!cycles) {', to: 'if (false) {', fails: ['worked: a log that starts after'] },
  { name: 'a cycle with a missing amount is added up', file: 'treasury-anchors.js', from: 'if (!finite(cycle.net) || cycle.rows !== cycle.amounts) {', to: 'if (!finite(cycle.net)) {', fails: ['worked: a log that starts after'] },
  { name: 'a use missing from the use table is not noted', file: 'treasury-anchors.js', from: 'unmatched += cycle.unmatched || 0', to: 'unmatched += 0', fails: ['worked: a use missing from the use table'] },
  { name: 'a total is given over an unknown window', file: 'treasury-anchors.js', from: "windows.length > 1 && windows.every((window) => window.status === 'known')", to: 'windows.length > 1', fails: ['worked: the whole span'] },
  { name: 'a snapshot at the open save\'s time is a second anchor', file: 'treasury-anchors.js', from: 'anchors.filter((anchor) => anchor.t !== live.t)', to: 'anchors', fails: ['worked: the open save\'s own treasury'] },
  { name: 'spending is read as income by the log read', file: 'treasury-anchors.js', from: 'case when DIM_WealthUse.Income <> 0 then FCT_WealthData.Amount else -FCT_WealthData.Amount end', to: 'case when DIM_WealthUse.Income is not null then FCT_WealthData.Amount else -FCT_WealthData.Amount end', fails: [LOG_READ] },
  { name: 'a use missing from the use table is income in the log read', file: 'treasury-anchors.js', from: 'case when DIM_WealthUse.Income <> 0 then', to: 'case when coalesce(DIM_WealthUse.Income, 1) <> 0 then', fails: [LOG_READ] },
  { name: 'the log read ignores the race', file: 'treasury-anchors.js', from: 'and FCT_WealthData.RaceID = $' + '{wholeNumber(RaceID)}', to: '', fails: [LOG_READ] },
  { name: 'the recorder stores no witness with a snapshot', file: 'history.js', from: 'snapshot: withChain(result.snapshot, observation)', to: 'snapshot: result.snapshot', fails: [RECORDED_LIFE, REWIND_LIFE, MERGE_LIFE] },
  { name: 'the recorder stores the witness of one increment fewer', file: 'history.js', from: 'const chain = { n: observation.count, digest: observation.lengthDigest }', to: 'const chain = { n: observation.count - 1, digest: observation.lengthDigest }', fails: [RECORDED_LIFE, MERGE_LIFE] },
  { name: 'a merge stamps the destination\'s witness on the snapshots it brings in', file: 'campaign-attach.js', from: 'const fresh = added.filter((snapshot) => !known.has(snapshot.t))', to: 'const fresh = added.filter((snapshot) => !known.has(snapshot.t)).map((snapshot) => ({ ...snapshot, chain: kept.length ? kept[kept.length - 1].chain : snapshot.chain }))', fails: [LEGACY_LIFE, MERGE_LIFE] },
  { name: 'the witness leaves out the Length of an increment', file: 'campaign.js', from: 'lengthDigest = hashText(`$' + '{lengthDigest}$' + '{row.IncrementID}:$' + '{row.GameTime}:$' + '{row.Length};`)', to: 'lengthDigest = hashText(`$' + '{lengthDigest}$' + '{row.IncrementID}:$' + '{row.GameTime};`)', fails: [LENGTH_ONLY, SQL_LENGTH, LENGTH_LIFE] },
  { name: 'the recorder stores the identity digest of the ledger as the witness', file: 'history.js', from: 'digest: observation.lengthDigest', to: 'digest: observation.digest', fails: [RECORDED_LIFE, LENGTH_LIFE] },
  { name: 'the open save\'s ledger is checked with the identity digest, which leaves out Length', file: 'treasury-anchors.js', from: 'exact: scanned.exactLength', to: 'exact: scanned.exact', fails: [LENGTH_ONLY, LENGTH_LIFE] },
  { name: 'the ledger read does not hold the Length of an increment', file: 'campaign.js', from: 'FCT_Increments.GameTime, FCT_Increments.Length from', to: 'FCT_Increments.GameTime from', fails: [SQL_LENGTH] },
]

// ---- Running -----------------------------------------------------------------------------------------------------------

// `only`: the starts of the full names ("group: name") of the checks to run, or all of them.
const runSuite = async (modules, only = null) => {
  const results = []

  for (const { group, name, run } of defineSuite(modules)) {
    if (only && !only.some((start) => `${group}: ${name}`.startsWith(start))) {
      continue
    }

    try {
      await run()
      results.push({ group, name, error: null })
    } catch (error) {
      if (!error.skipped) {
        results.push({ group, name, error })
      }
    }
  }

  return results
}

const copySources = (copy) => fs.cpSync(path.join(src, 'renderer', 'utilities'), path.join(copy, 'renderer', 'utilities'), { recursive: true })

const applyMutations = async (copy) => {
  refusePlanting('the treasury-anchor faults')

  const results = []

  const only = (process.argv.find((argument) => argument.startsWith('--only=')) || '').slice('--only='.length).split('|').filter(Boolean)

  for (const mutation of MUTATIONS.filter(({ name }) => !only.length || only.some((text) => name.includes(text)))) {
    const target = path.join(copy, 'renderer', 'utilities', mutation.file)
    const original = fs.readFileSync(target, 'utf8')
    const parts = original.split(mutation.from)

    if (parts.length !== 2) {
      results.push({ group: 'mutations', name: mutation.name, error: new Error(`the text to break occurs ${parts.length - 1} times in ${mutation.file}, not once: the mutation no longer applies`) })
      continue
    }

    fs.writeFileSync(target, parts.join(mutation.to))

    try {
      const modules = await loadModules(copy)
      const wanted = mutation.fails
      const outcome = await runSuite(modules, wanted)
      const invalid = outcome.find((entry) => entry.error && (kindOf(entry.error) !== 'assertion' || isSubjectThrow(entry.error)))

      if (invalid) {
        throw invalid.error
      }

      const failed = outcome.filter((entry) => entry.error)
      const named = (entry, start) => `${entry.group}: ${entry.name}`.startsWith(start)
      const missed = wanted.filter((start) => !failed.some((entry) => named(entry, start)))
      const absent = wanted.filter((start) => !outcome.some((entry) => named(entry, start)))

      if (process.argv.includes('--detail')) {
        failed.forEach((entry) => console.log(`CAUGHT ${mutation.name} by ${entry.group}: ${entry.name}: ${entry.error.message}`))
      }

      results.push({ group: 'mutations', name: `${mutation.name} (fails: ${wanted.join('; ')})`, error: absent.length ? new Error(`no check is named ${absent.join('; ')}`) : missed.length ? new Error(`the checks that guard this did not fail: ${missed.join('; ')}`) : null })
    } catch (error) {
      results.push({ group: 'mutations', name: mutation.name, error })
    } finally {
      fs.writeFileSync(target, original)
    }
  }

  return results
}

const main = async () => {
  const modules = await loadModules(src)

  const results = await runSuite(modules)

  if (mutating()) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-anchors-'))

    try {
      copySources(copy)
      results.push(...await applyMutations(copy))
    } finally {
      fs.rmSync(copy, { recursive: true, force: true })
    }
  }

  let group = null

  results.forEach(({ group: next, name, error }) => {
    if (next !== group) {
      group = next
      console.log(`\n${group}`)
    }

    console.log(error ? `  FAIL   ${name}\n         ${String(error.stack || error.message).split('\n').slice(0, 6).join('\n         ')}` : `  ok     ${name}`)
  })

  const failed = results.filter((entry) => entry.error).length

  console.log(`\n${results.length} checks: ${results.length - failed} ok, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
