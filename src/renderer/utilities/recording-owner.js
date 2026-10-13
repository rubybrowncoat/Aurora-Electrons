// One window or tab records a database. The registry and the history files are read, changed and written whole, so two writers of one database would drop each other's campaigns or settle a save against a stale tip. The app is one process with a window per database (src/main/launch.js), and the web build's tabs share one browser storage; in both a window asks the browser for a Web Lock named for its database and holds it for as long as it is open. The window granted it owns the recording of that database (the recorder, the player's answers about campaigns, clearing a history, the migration); any other window or tab of the same database only reads and takes over when the owner closes. Windows of different databases record at the same time, their steps taken one at a time under one shared registry lock (`withRegistry`), because the registry and the campaigns are shared by every database. Where the browser has no Web Locks every window owns, and the registry's compare before every write (utilities/campaign.js `RegistryChanged`) is the only guard.

const OWNER_PREFIX = 'aurora-electrons:recording-owner:'
const REGISTRY_LOCK = 'aurora-electrons:registry'
const GRACE = 2000

let state = 'owner'
let granted = null
let claim = null

// A write was asked for by a window that is not the recording owner of its database. Nothing was written.
export class ReadOnly extends Error {
  constructor () {
    super('Another window or tab of this app records this database, so this one only reads the history and the campaigns')
    this.name = 'ReadOnly'
    this.readOnly = true
  }
}

const hasLocks = () => typeof navigator !== 'undefined' && !!navigator.locks

// Asks for the recording lock of `database`, once per database, when the window starts recording. `onOwner()` is called when it is granted, which for a window that had to wait is after the previous owner closed. Claiming another database releases the lock of the one held (a window that switches to another save). A browser that refuses the lock leaves the window the owner.
export const claimRecording = ({ database = '', onOwner = () => {} } = {}) => {
  if (claim && claim.database === database) {
    return
  }

  if (claim) {
    claim.release()
  }

  const mine = { database, released: false, free: () => {}, release: () => {} }

  mine.release = () => {
    mine.released = true
    mine.free()
  }
  claim = mine

  if (!hasLocks()) {
    state = 'owner'
    granted = Promise.resolve(true)

    return
  }

  state = 'waiting'
  granted = new Promise((resolve) => {
    const own = () => {
      if (claim === mine) {
        state = 'owner'
      }

      resolve(true)
    }

    try {
      navigator.locks.request(`${OWNER_PREFIX}${database}`, async () => {
        if (mine.released) {
          return
        }

        own()

        if (claim === mine) {
          onOwner()
        }

        // Held until the window closes, or claims another database.
        await new Promise((resolve) => {
          mine.free = resolve
        })
      }).catch(own)
    } catch (error) {
      own()
    }
  })
}

// Gives up the recording lock held or waited for, at once: a window that moves to another save no longer records the first, and another window of that database may take over. The next `claimRecording` asks for the new database's.
export const releaseRecording = () => {
  if (claim) {
    claim.release()
    claim = null
  }

  state = 'owner'
  granted = null
}

export const ownsRecording = () => state === 'owner'

// Every writer of the registry, the history files and the migration record asks this first (the stores `utilities/history.js` opens do it on every write, and the player's answers and the recorder before they read what they will write).
export const requireRecording = () => {
  if (state !== 'owner') {
    throw new ReadOnly()
  }
}

// Whether this window records, waiting up to `grace` ms for the lock: a reloaded window asks while the page it replaces is still releasing its own.
export const recordingOwner = async (grace = GRACE) => {
  if (state === 'owner') {
    return true
  }

  let timer
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), grace)
  })

  try {
    return await Promise.race([granted, late])
  } finally {
    clearTimeout(timer)
  }
}

// Runs `work` as the only step of any window on the registry: every read-decide-write of it (a recorder pass, a player's answer, clearing a history) goes through here, so a window of another database cannot change what `work` has read before it writes. The callback is async so that a throw rejects the request, which releases the lock.
export const withRegistry = async (work) => (hasLocks() ? navigator.locks.request(REGISTRY_LOCK, async () => work()) : work())
