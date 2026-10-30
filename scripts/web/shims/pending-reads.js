// Web mode: the calls this page has out to the database middleware, kept at `window.__auroraReads` for a check that waits until the page has finished reading (`settled` of scripts/lib/browser-observe.js). The page does not use it and no call changes: a call is counted from the moment it starts until its answer has been read and the caller is about to go on.
//
// - pending: the calls out, by an id, each with a short label of what it asks, for a wait that gives up to say what it waited for;
// - started: how many calls have started since the page loaded, which a call that a watcher starts after another one finished moves;
// - idle(): a promise that settles once no call is out (at once when none is).
//
// A call ends in a microtask of its own, before the caller's code that follows the answer runs, so a read that this answer makes a watcher or an awaiting caller start is counted before anything can look at the count again from a later task.

const LABEL_LIMIT = 120

const pending = new Map()

let started = 0
let waiting = []

const reads = {
  pending,
  get started () {
    return started
  },
  idle: () => (pending.size ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve()),
}

window.__auroraReads = reads

// `work()` counted as a call out until it settles, answered or failed; its result or failure goes on unchanged.
export const tracked = (label, work) => {
  const id = ++started

  pending.set(id, String(label).slice(0, LABEL_LIMIT))

  return work().finally(() => {
    pending.delete(id)

    if (!pending.size) {
      const done = waiting

      waiting = []
      done.forEach((resolve) => resolve())
    }
  })
}
