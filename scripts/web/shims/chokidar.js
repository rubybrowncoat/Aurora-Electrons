// Web mode stand-in for `chokidar`: emits `add` once, then polls the dev server for the database's mtime and emits `change` when it moves, until it is closed.

import { databaseRequest } from './database-request'

const POLL_INTERVAL = 2000

export const watch = (path) => {
  const handlers = { add: [], change: [] }
  const emit = (event) => handlers[event].forEach((handler) => handler(path, {}))

  let closed = false
  let timer = null

  const watcher = {
    close () {
      closed = true
      clearTimeout(timer)

      return Promise.resolve()
    },
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

  const poll = () => databaseRequest(`/stat?path=${encodeURIComponent(path)}`).then((response) => (response.ok ? response.json() : null)).then((stat) => {
    if (!stat || closed) {
      return
    }

    if (lastModified === null) {
      emit('add')
    } else if (stat.mtimeMs !== lastModified) {
      emit('change')
    }

    lastModified = stat.mtimeMs
  }).catch(() => {}).finally(() => {
    if (!closed) {
      timer = setTimeout(poll, POLL_INTERVAL)
    }
  })

  poll()

  return watcher
}

export default { watch }
