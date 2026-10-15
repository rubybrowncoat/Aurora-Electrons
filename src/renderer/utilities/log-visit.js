// The Game Log's last look, kept per branch of a campaign: `campaign.<campaign id>.race.<RaceID>.logLastSeen` is { [branchId]: { t } } with `t` the end game time (GameTime + Length) of the newest increment the save held at the visit. An event is new when its Time is later than the branch's `t`, so a position in the branch's own timeline decides, never an IncrementID (after a fork the same IncrementID names another increment). Before the branches the key held one number, the newest IncrementID of the save at the visit.

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const isTime = (value) => typeof value === 'number' && Number.isFinite(value)

// The `t` a branch has, its own or else the lesser of its parent's and the game time it left the parent at (through the lineage, { [branchId]: { parent, t } }), or null when nothing says. A fork whose time was not recorded takes the parent's.
const lookOf = (look, branch, lineage, walked = new Set()) => {
  if (isObject(look[branch]) && isTime(look[branch].t)) {
    return look[branch].t
  }

  const own = lineage[branch]

  if (walked.has(branch) || !own || typeof own.parent !== 'string') {
    return null
  }

  walked.add(branch)

  const parent = lookOf(look, own.parent, lineage, walked)

  return parent === null ? null : isTime(own.t) ? Math.min(parent, own.t) : parent
}

// What the stored value says of the open branch: { t, converted } with `t` the game time events are compared with (null: a first visit) and `converted` whether it came from the old number. A number is looked up in `ledger` (Map(IncrementID -> [IncrementID, GameTime, Length]) of the open save); one that save no longer holds is a first visit, and `waiting` says the ledger is not yet read.
export const readLook = (stored, branch, ledger, lineage) => {
  if (typeof stored === 'number') {
    if (!ledger) {
      return { t: null, converted: false, waiting: true }
    }

    const increment = ledger.get(stored)

    return increment ? { t: increment[1] + increment[2], converted: true } : { t: null, converted: false }
  }

  return { t: isObject(stored) ? lookOf(stored, branch, lineage || {}) : null, converted: false }
}

export const isNewEvent = (event, t) => t !== null && event.Time > t

// The end game time of the newest increment of a ledger, or null when it holds none.
export const newestEnd = (ledger) => {
  if (!ledger || !ledger.size) {
    return null
  }

  const newest = [...ledger.values()].reduce((latest, increment) => (increment[0] > latest[0] ? increment : latest))

  return newest[1] + newest[2]
}

// The stored value after this visit: the branch's entry is the save's newest end, not the highest ever seen, so an earlier save of the same branch counts from where it stands. An old number is replaced by the record.
export const withLook = (stored, branch, t) => ({ ...(isObject(stored) ? stored : {}), [branch]: { t } })
