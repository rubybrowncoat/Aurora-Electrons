import { ipcRenderer } from 'electron'

const flags = new Map()

// The race flag in Aurora's `Flags` folder as a data URL, or null when it is missing or unreadable.
// The main process reads it (a `file://` image is blocked in a packaged build); each name is asked for once per session.
export const flagUrl = (name) => {
  if (!flags.has(name)) {
    flags.set(name, ipcRenderer.invoke('read-flag', name).catch(() => null))
  }

  return flags.get(name)
}
