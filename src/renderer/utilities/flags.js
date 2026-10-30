import { ipcRenderer } from 'electron'

// The flags read for the save the window shows. Each save has its own folder of them and a name repeats between saves, so they are kept for one save only: `setFlagScope` starts them over when the window shows another.
let scope = null
let flags = new Map()

export const setFlagScope = (database) => {
  scope = database
  flags = new Map()
}

// The race flag in Aurora's `Flags` folder as a data URL, or null when it is missing or unreadable. The main process reads it (a `file://` image is blocked in a packaged build); each name is asked for once per save. The request names the save it is for, and an answer that arrives after the window has moved to another save is null, never the old save's flag in the new one's place.
export const flagUrl = (name) => {
  const mine = scope
  const cache = flags

  if (!cache.has(name)) {
    cache.set(name, ipcRenderer.invoke('read-flag', name, mine).catch(() => null).then((url) => (scope === mine ? url : null)))
  }

  return cache.get(name)
}
