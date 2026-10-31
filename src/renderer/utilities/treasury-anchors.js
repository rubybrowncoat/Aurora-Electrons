// The Finances page's check of the treasury against the wealth log: between two recorded snapshots of one race, the stored change of the treasury is the logged net of the cycles between them plus a residual, the part the log does not hold. The residual is never attributed to a cause, and it is unknown, never 0, whenever the two snapshots cannot be shown to lie on the open save's own history (each carries a digest of the ledger it was taken on, which the open save's ledger must reproduce) or the log does not cover the span. Every figure is a provenance result (utilities/provenance.js).

import { scanLedger } from './campaign'
import { SECONDS_PER_DAY } from './finances'
import { isChain } from './history'
import { ofRule, registerRule, unavailable } from './provenance'

// A residual no larger than this is float noise from adding thousands of amounts, so the window balances.
export const BALANCE_TOLERANCE = 1e-6

registerRule({
  id: 'finances.treasuryResidual',
  versions: ['2.7.x'],
  units: 'wealth',
  verification: 'estimated',
  structure: ['history snapshots (wealth, game time)', 'FCT_WealthData.UseID, TimeUsed, Amount', 'DIM_WealthUse.Income', 'FCT_Race.WealthPoints'],
  note: 'Between two recorded snapshots of one race, the stored change of the treasury less the net of the logged cycles with a time after the earlier snapshot and up to the later one. A snapshot counts only when the ledger of the open save, digested up to the increment count the snapshot was taken at, equals the digest stored with it. It is what the log does not hold, and no transaction is named for it. It is unknown, not 0, when a snapshot has no stored digest (recorded before the app kept one), is not an earlier point of the open save (another branch, a merged history, a replayed past, a rewound save that holds fewer increments), lies after the open save or holds no treasury, and when the log does not reach back to the earlier snapshot or holds no cycle between the two. It is 0 only when the log accounts for the whole stored change. A window need not end on a logged cycle; the time after the last logged cycle is stated as coverage.',
  assumptions: ['a cycle logged at the time of a snapshot is already in that snapshot\'s treasury'],
})

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

const wholeNumber = (value) => {
  const number = Number(value)

  if (!Number.isInteger(number)) {
    throw new TypeError(`Not a whole number: ${value}`)
  }

  return number
}

// The race's whole wealth log as one row per logged time: `t`, `net` (the income less the spending, by the use's Income flag; a use missing from DIM_WealthUse counts as spending, as the ledger counts it), `rows`, `amounts` (the rows that hold an amount) and `unmatched` (the rows of a use missing from DIM_WealthUse). One grouped read of the log, not a read per use.
export const wealthLogSql = (GameID, RaceID) => `select FCT_WealthData.TimeUsed as t, sum(case when DIM_WealthUse.Income <> 0 then FCT_WealthData.Amount else -FCT_WealthData.Amount end) as net, count(*) as rows, count(FCT_WealthData.Amount) as amounts, sum(case when DIM_WealthUse.Income is null then 1 else 0 end) as unmatched from FCT_WealthData left join DIM_WealthUse on DIM_WealthUse.WealthUseID = FCT_WealthData.UseID where FCT_WealthData.GameID = ${wholeNumber(GameID)} and FCT_WealthData.RaceID = ${wholeNumber(RaceID)} group by FCT_WealthData.TimeUsed order by FCT_WealthData.TimeUsed`

// The snapshots of one race in one branch's history file, as anchors. A snapshot without a game time is no anchor; one without a stored treasury stays one, with a null treasury, so it reads as unknown and never as 0. `chain` is the witness the recorder stored with the snapshot ({ n, digest }, utilities/history.js `isChain`), null for a snapshot recorded without one.
export const recordedAnchors = ({ snapshots }) => (Array.isArray(snapshots) ? snapshots : []).filter((snapshot) => snapshot && finite(snapshot.t)).map((snapshot) => ({ t: snapshot.t, wealth: finite(snapshot.wealth) ? snapshot.wealth : null, chain: isChain(snapshot.chain) ? { n: snapshot.chain.n, digest: snapshot.chain.digest } : null }))

// What the open save's own ledger shows of the recorded snapshots: its increment count and its chained digest after each increment count a snapshot was taken at (and only those), the digest that also covers each increment's Length, as the witness the recorder stored does. `rows` are the ledger's [{ IncrementID, GameTime, Length }] in order (campaign.js `ledgerSql`). Any increment count is checked at exactly that count, never at a checkpoint below it.
export const ledgerEvidence = (rows, anchors) => {
  const scanned = scanLedger(rows, anchors.filter((anchor) => anchor.chain).map((anchor) => anchor.chain.n))

  return { count: scanned.count, exact: scanned.exactLength }
}

const unknownResult = (reason) => unavailable({ rule: 'finances.treasuryResidual', missing: [reason] })

// Why a recorded anchor cannot be compared with this save, or null: the snapshot must hold a treasury, not be later than the open save, and carry a witness that the open save's own ledger, digested up to the snapshot's increment count, reproduces. Nothing else vouches for it: the campaign and branch a history file belongs to, how the recorder settled the save and where a snapshot came from are bookkeeping that a merge, an attach or a rewound replay can leave behind a snapshot of another history.
const refusal = (anchor, { live, ledger }) => {
  if (!finite(anchor.wealth)) {
    return 'the snapshot holds no treasury'
  }

  if (anchor.t > live.t) {
    return 'the snapshot is later than the open save, so this save\'s log does not reach it'
  }

  if (!anchor.chain) {
    return 'the snapshot was recorded before the app kept the ledger it was taken on (or came from another history), so it is not verified to lie on this save\'s history'
  }

  if (!ledger || !(ledger.count > 0)) {
    return 'this save\'s ledger is not read, so no snapshot is verified to lie on its history'
  }

  if (anchor.chain.n > ledger.count) {
    return 'the snapshot was taken after more increments than this save holds, so it is not an earlier point of this save'
  }

  if (ledger.exact[anchor.chain.n] !== anchor.chain.digest) {
    return 'the snapshot was taken on a different ledger from this save\'s (another branch, a merged history or a replayed past), so it is not an earlier point of this save'
  }

  return null
}

// The first index of `log` (sorted by time) whose time is after `time`.
const firstAfter = (log, time) => {
  let low = 0
  let high = log.length

  while (low < high) {
    const middle = (low + high) >> 1

    if (log[middle].t > time) {
      high = middle
    } else {
      low = middle + 1
    }
  }

  return low
}

const blockedWindow = (from, to, reason) => ({ from: from.t, to: to.t, days: (to.t - from.t) / SECONDS_PER_DAY, status: 'unknown', reason, storedChange: null, loggedNet: null, residual: null, balanced: false, cycles: 0, coverage: null, result: unknownResult(reason) })

// One pair of neighbouring comparable anchors: the stored change, the logged net of the cycles in (from, to] and the residual, with the log's coverage, or unknown with the reason.
const windowOf = (from, to, log) => {
  const base = { from: from.t, to: to.t, days: (to.t - from.t) / SECONDS_PER_DAY }
  const unknown = (reason) => blockedWindow(from, to, reason)

  if (!log.length) {
    return unknown('the save logs no wealth for the race')
  }

  if (log[0].t > from.t) {
    return unknown('the log starts after the earlier snapshot, so it does not cover the span')
  }

  let loggedNet = 0
  let cycles = 0
  let last = null
  let unmatched = 0

  for (let index = firstAfter(log, from.t); index < log.length && log[index].t <= to.t; index++) {
    const cycle = log[index]

    if (!finite(cycle.net) || cycle.rows !== cycle.amounts) {
      return unknown('a logged amount in the span is missing, so its net is not known')
    }

    loggedNet += cycle.net
    cycles++
    last = cycle.t
    unmatched += cycle.unmatched || 0
  }

  if (!cycles) {
    return unknown('the log holds no cycle between the two snapshots')
  }

  const storedChange = to.wealth - from.wealth
  const difference = storedChange - loggedNet
  const balanced = Math.abs(difference) <= BALANCE_TOLERANCE
  const residual = balanced ? 0 : difference
  const assumptions = unmatched ? ['a use missing from the wealth use table counts as spending'] : []
  const coverage = { cycles, days: base.days, loggedThrough: last, unloggedTail: (to.t - last) / SECONDS_PER_DAY }
  const result = ofRule({ rule: 'finances.treasuryResidual', value: residual, inputs: { present: ['recorded snapshots', 'wealth log'] }, assumptions })

  return { ...base, status: 'known', reason: '', storedChange, loggedNet, residual, balanced, cycles, coverage, result }
}

// The whole span of windows that are all known: the stored change, the logged net and the residual added up, and no more than the windows hold.
const totalOf = (windows) => {
  const sum = (key) => windows.reduce((all, window) => all + window[key], 0)
  const first = windows[0]
  const last = windows[windows.length - 1]
  const balanced = windows.every((window) => window.balanced)
  const assumptions = [...new Set(windows.flatMap((window) => window.result.assumptions))]
  const residual = balanced ? 0 : sum('residual')
  const result = ofRule({ rule: 'finances.treasuryResidual', value: residual, inputs: { present: ['recorded snapshots', 'wealth log'] }, assumptions })

  return { from: first.from, to: last.to, days: (last.to - first.from) / SECONDS_PER_DAY, storedChange: sum('storedChange'), loggedNet: sum('loggedNet'), residual, balanced, cycles: sum('cycles'), windows: windows.length, result }
}

// The check of the treasury over a branch's recorded snapshots and the open save's own treasury, which is always the last anchor: { reason, windows, total }. `windows` are the neighbouring pairs of anchors in time order, each known (stored change, logged net, residual, coverage) or unknown with its reason, so a snapshot that cannot be compared splits the line and no pair ever spans it. `total` is the whole span when every window is known and there are two or more.
// `settled` is whether the recorder has settled the open save to a campaign, `anchors` the recorded snapshots (recordedAnchors), `live` the open save's { t, wealth }, `log` the save's own wealth log as one entry per logged time, [{ t, net, rows, amounts, unmatched }] with `net` the income less spending (a use missing from the wealth use table counts as spending), `rows` the rows of that time and `amounts` how many of them hold an amount, and `ledger` the open save's own ledger as ledgerEvidence reads it. A snapshot counts only when its witness is that ledger's digest at the snapshot's own increment count.
export const reconcileTreasury = ({ settled, anchors, live, log, ledger = null }) => {
  const none = (reason) => ({ reason, windows: [], total: null })

  if (!settled) {
    return none('The campaign this save belongs to is not settled yet')
  }

  if (!live || !finite(live.t) || !finite(live.wealth)) {
    return none('The save stores no treasury for the race')
  }

  const recorded = anchors.filter((anchor) => anchor.t !== live.t).map((anchor) => ({ anchor, reason: refusal(anchor, { live, ledger }) }))
  const ordered = [...recorded, { anchor: { t: live.t, wealth: live.wealth }, reason: null }].sort((a, b) => a.anchor.t - b.anchor.t)

  if (ordered.length < 2) {
    return none('No earlier snapshot of the race is recorded on this save\'s branch')
  }

  const sorted = log.slice().sort((a, b) => a.t - b.t)
  const windows = ordered.slice(1).map((later, index) => {
    const earlier = ordered[index]
    const blocked = earlier.reason || later.reason

    return blocked ? blockedWindow(earlier.anchor, later.anchor, blocked) : windowOf(earlier.anchor, later.anchor, sorted)
  })
  const total = windows.length > 1 && windows.every((window) => window.status === 'known') ? totalOf(windows) : null

  return { reason: null, windows, total }
}

// A residual as the page prints it, with `signed` the page's figure format: a balanced window (the residual exactly 0) prints 0, and a residual under 1 prints its first two significant digits, so one that is not 0 never reads as 0.
export const residualLabel = (residual, signed) => {
  if (!finite(residual)) {
    return '—'
  }

  if (residual === 0) {
    return '0'
  }

  if (Math.abs(residual) >= 1) {
    return signed(residual)
  }

  return `${residual < 0 ? '−' : '+'}${String(Number(Math.abs(residual).toPrecision(2)))}`
}
