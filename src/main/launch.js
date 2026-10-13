import path from 'path'

// Which database two launches mean, and what a second launch does. The app runs as one process per user-data folder (the single-instance lock), with one window per database: a launch for a database that has a window brings that window forward, a launch for another database opens a window of its own in the running process.

// A database path as a key to compare: separators and `..` settled, no trailing separator, and case ignored on Windows (a case-insensitive file system).
export const databaseKey = (file, platform = process.platform) => {
  const flavour = platform === 'win32' ? path.win32 : path.posix
  const normal = flavour.normalize(String(file))
  const trimmed = normal.length > 1 ? normal.replace(/[\\/]+$/, '') : normal

  return platform === 'win32' ? trimmed.toLowerCase() : trimmed
}

// What the running process does with a launch that asked for `requested` (a database path, or nothing): { action: 'focus', id } to bring the window `id` forward, or { action: 'open' } to open a window for it. `open` is [{ id, database }], one per window.
export const routeLaunch = (requested, open, platform = process.platform) => {
  if (!requested) {
    return open.length ? { action: 'focus', id: open[0].id } : { action: 'open' }
  }

  const key = databaseKey(requested, platform)
  const found = open.find((window) => databaseKey(window.database, platform) === key)

  return found ? { action: 'focus', id: found.id } : { action: 'open' }
}

// What a window that asks to switch to `requested` does: { action: 'unchanged' } when it already has that database, { action: 'focus', id } when another window has it (that window comes forward and the asking one keeps its own: one window per database), else { action: 'switch' }. `open` is [{ id, database }], one per window, the asking window `id` among them.
export const routeSwitch = (requested, id, open, platform = process.platform) => {
  const key = databaseKey(requested, platform)
  const own = open.find((window) => window.id === id)

  if (own && databaseKey(own.database, platform) === key) {
    return { action: 'unchanged' }
  }

  const found = open.find((window) => window.id !== id && databaseKey(window.database, platform) === key)

  return found ? { action: 'focus', id: found.id } : { action: 'switch' }
}
