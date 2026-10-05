// Web mode stand-in for `chokidar`: emits `add` once, then polls the dev
// server for the database's mtime and emits `change` when it moves.

const POLL_INTERVAL = 2000

export const watch = (path) => {
  const handlers = { add: [], change: [] }
  const emit = (event) => handlers[event].forEach((handler) => handler(path, {}))

  const watcher = {
    on (event, handler) {
      if (handlers[event]) {
        handlers[event].push(handler)
      }

      return watcher
    },
    once (event, handler) {
      const wrapped = (...args) => {
        handlers[event] = handlers[event].filter((entry) => entry !== wrapped)
        handler(...args)
      }

      return watcher.on(event, wrapped)
    },
  }

  let lastModified = null

  const poll = () => fetch('/__aurora-db/stat')
    .then((response) => (response.ok ? response.json() : null))
    .then((stat) => {
      if (!stat) {
        return
      }

      if (lastModified === null) {
        emit('add')
      } else if (stat.mtimeMs !== lastModified) {
        emit('change')
      }

      lastModified = stat.mtimeMs
    })
    .catch(() => {})
    .finally(() => setTimeout(poll, POLL_INTERVAL))

  poll()

  return watcher
}

export default { watch }
