import path from 'path'

import { databaseKey, routeSwitch } from './launch'

// Which save a window shows, and how it changes. The main process is the authority on it: a window asks for its database (`request-storage-path`), reads the flags beside it and switches it only through the service below, which checks the file, keeps the one-window-per-database rule (src/main/launch.js) and keeps the recent saves. The file chosen is only ever read: never moved, copied over or written here.

// How many saves the recent list keeps; the oldest one goes when another is added.
export const RECENT_LIMIT = 10

// How long a file may take to answer before it counts as unavailable (a network drive that has gone away can block a read for a long time).
const PROBE_TIMEOUT_MS = 3000

const SQLITE_HEADER = 'SQLite format 3\u0000'

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// Why a file could not be read, as a clause that follows the file's name.
const reasonOf = (error) => {
  const code = error && error.code

  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return 'the file does not exist'
  } else if (code === 'EACCES' || code === 'EPERM') {
    return 'access to the file is denied'
  } else if (code === 'EBUSY' || code === 'EAGAIN') {
    return 'the file is locked by another program'
  }

  return `the file could not be read (${code || String((error && error.message) || error).split(/\r?\n/)[0]})`
}

// Whether `file` can be opened as a save now: { ok: true }, or { ok: false, reason }. Only its first bytes are read (it must be an SQLite database); `fs` is the promise API (`stat`, `open`).
export const probeSave = async (file, { fs, timeoutMs = PROBE_TIMEOUT_MS }) => {
  let timer

  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: `the file did not answer within ${timeoutMs / 1000} s` }), timeoutMs)
  })

  const work = (async () => {
    const stat = await fs.stat(file)

    if (!stat.isFile()) {
      return { ok: false, reason: 'the path is not a file' }
    } else if (stat.size === 0) {
      return { ok: false, reason: 'the file is empty' }
    }

    const handle = await fs.open(file, 'r')

    try {
      const { bytesRead, buffer } = await handle.read(Buffer.alloc(SQLITE_HEADER.length), 0, SQLITE_HEADER.length, 0)

      return buffer.toString('latin1', 0, bytesRead) === SQLITE_HEADER ? { ok: true } : { ok: false, reason: 'the file is not an SQLite database' }
    } finally {
      await handle.close()
    }
  })().catch((error) => ({ ok: false, reason: reasonOf(error) }))

  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

// The saves opened most recently, newest first, in a store read and written whole (`store.read()` gives the stored value, `store.write(value)` replaces it): [{ path, openedAt }]. A path is kept as it was last opened, once per file.
export const createRecent = ({ store, now = Date.now, limit = RECENT_LIMIT, platform = process.platform }) => {
  const same = (a, b) => databaseKey(a, platform) === databaseKey(b, platform)

  // Throws when the stored list is not one this version wrote, which is left as it is.
  const list = () => {
    const stored = store.read()

    if (stored === undefined || stored === null || (isObject(stored) && !Object.keys(stored).length)) {
      return []
    } else if (!isObject(stored) || !Array.isArray(stored.saves)) {
      throw new Error('The list of recent saves is damaged')
    }

    return stored.saves.filter((entry) => isObject(entry) && typeof entry.path === 'string' && entry.path).map(({ path: file, openedAt }) => ({ path: file, openedAt: typeof openedAt === 'number' ? openedAt : null }))
  }

  const write = (saves) => {
    store.write({ version: 1, saves: saves.slice(0, limit) })
  }

  return {
    list,
    // `file` is now the most recent.
    note (file) {
      write([{ path: file, openedAt: now() }, ...list().filter((entry) => !same(entry.path, file))])
    },
    forget (file) {
      write(list().filter((entry) => !same(entry.path, file)))
    },
  }
}

// The paths a window may ask for are absolute and name a file, never a URL or a path with a NUL.
const normalise = (requested) => (typeof requested === 'string' && requested.length && !requested.includes('\u0000') && path.isAbsolute(requested) ? path.resolve(requested) : null)

// What the windows' IPC handlers answer. `windows` is { list() -> [{ id, database }], databaseOf(id), has(id), switchTo(id, database), focus(id), parent(id) }, `recent` is createRecent's, `dialog` is Electron's, `fs` the promise API of the file system.
export const createSaveService = ({ windows, recent, dialog, fs, platform = process.platform, timeoutMs = PROBE_TIMEOUT_MS, log = console }) => {
  const probe = (file) => probeSave(file, { fs, timeoutMs })
  const same = (a, b) => databaseKey(a, platform) === databaseKey(b, platform)
  const choosing = new Set()
  const chains = new Map()

  // The switches and removals of one window run one at a time.
  const serial = (id, work) => {
    const run = (chains.get(id) || Promise.resolve()).then(work, work)

    chains.set(id, run.catch(() => {}))

    return run
  }

  const safely = (work) => {
    try {
      work()

      return null
    } catch (error) {
      log.error('The recent saves could not be kept', error)

      return String((error && error.message) || error)
    }
  }

  const gone = { ok: false, action: 'gone', active: null, reason: 'the window is closed' }

  // The recent saves with the state of each file now, the active path with its own, and which are open in another window: what the open-save panel shows.
  const state = async (id) => {
    const active = windows.databaseOf(id)
    const others = windows.list().filter((window) => window.id !== id).map(({ database }) => database)
    let saves = []
    let error = null

    try {
      saves = recent.list()
    } catch (problem) {
      error = String((problem && problem.message) || problem)
    }

    const [now, ...found] = await Promise.all([probe(active), ...saves.map(({ path: file }) => probe(file))])

    return {
      active: { path: active, state: now.ok ? 'available' : 'unavailable', reason: now.ok ? null : now.reason },
      limit: RECENT_LIMIT,
      error,
      recent: saves.map(({ path: file, openedAt }, index) => ({
        path: file,
        name: path.basename(file),
        folder: path.dirname(file),
        openedAt,
        state: found[index].ok ? 'available' : 'unavailable',
        reason: found[index].ok ? null : found[index].reason,
        active: same(file, active),
        openElsewhere: others.some((database) => same(database, file)),
      })),
    }
  }

  const focused = (id, other, file) => {
    windows.focus(other)
    safely(() => recent.note(file))

    return { ok: true, action: 'focused', path: file, active: windows.databaseOf(id), reason: 'that save is already open in another window, which is now in front' }
  }

  // Switches window `id` to `requested`. The answer is { ok, action, path, active, reason }: 'switched' (the window now shows `path`), 'unchanged' (it already did), 'focused' (another window has it open, so that one is brought forward and this one keeps its save), 'unavailable' (the file cannot be opened, so nothing changed; `reason` says why) or 'gone'. A file chosen in the dialog that cannot be opened is still kept in the recent list, to try again.
  const select = (id, requested, { chosen = false } = {}) => serial(id, async () => {
    if (!windows.has(id)) {
      return gone
    }

    const active = windows.databaseOf(id)
    const file = normalise(requested)

    if (!file) {
      return { ok: false, action: 'unavailable', path: typeof requested === 'string' ? requested : null, active, reason: 'the path is not an absolute file path' }
    }

    const route = routeSwitch(file, id, windows.list(), platform)

    if (route.action === 'unchanged') {
      return { ok: true, action: 'unchanged', path: active, active }
    } else if (route.action === 'focus') {
      return focused(id, route.id, file)
    }

    const found = await probe(file)

    if (!found.ok) {
      if (chosen) {
        safely(() => recent.note(file))
      }

      return { ok: false, action: 'unavailable', path: file, active: windows.has(id) ? windows.databaseOf(id) : null, reason: found.reason }
    }

    // Another window may have taken that database while the file was read.
    if (!windows.has(id)) {
      return gone
    }

    const again = routeSwitch(file, id, windows.list(), platform)

    if (again.action === 'focus') {
      return focused(id, again.id, file)
    } else if (again.action === 'unchanged') {
      return { ok: true, action: 'unchanged', path: windows.databaseOf(id), active: windows.databaseOf(id) }
    }

    windows.switchTo(id, file)
    safely(() => recent.note(file))

    return { ok: true, action: 'switched', path: file, active: file }
  })

  return {
    state,
    select,
    // The open dialog of window `id`, then the same as `select` for what is chosen. Closing it changes nothing.
    async choose (id) {
      if (!windows.has(id)) {
        return gone
      } else if (choosing.has(id)) {
        return { ok: true, action: 'busy', path: null, active: windows.databaseOf(id) }
      }

      choosing.add(id)

      try {
        const parent = windows.parent(id)
        const options = { title: 'Open an Aurora save', buttonLabel: 'Open save', defaultPath: path.dirname(windows.databaseOf(id)), properties: ['openFile'], filters: [{ name: 'Aurora saves', extensions: ['db'] }, { name: 'All files', extensions: ['*'] }] }
        const picked = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options))

        if (!picked || picked.canceled || !Array.isArray(picked.filePaths) || !picked.filePaths.length) {
          return { ok: true, action: 'canceled', path: null, active: windows.has(id) ? windows.databaseOf(id) : null }
        }

        return await select(id, picked.filePaths[0], { chosen: true })
      } finally {
        choosing.delete(id)
      }
    },
    // Takes `file` off the recent list; the save the window has open stays open.
    forget: (id, file) => serial(id, async () => {
      const problem = safely(() => recent.forget(String(file)))

      return problem ? { ok: false, action: 'unavailable', path: String(file), active: windows.has(id) ? windows.databaseOf(id) : null, reason: problem } : { ok: true, action: 'forgotten', path: String(file), active: windows.has(id) ? windows.databaseOf(id) : null }
    }),
    // A window opened `database`: it is the most recent save if the file is a save.
    async opened (database) {
      if ((await probe(database)).ok) {
        safely(() => recent.note(database))
      }
    },
    // Whether the flags of `database` are those of the save window `id` has open now. A flag asked for after the window moved to another save is the old save's, and is not answered.
    flagsBelongTo (id, database) {
      return database === undefined || database === null || (typeof database === 'string' && windows.has(id) && same(database, windows.databaseOf(id)))
    },
  }
}
