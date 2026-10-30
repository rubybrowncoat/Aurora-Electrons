// Web mode stand-in for `chokidar`: polls the dev server for the database's mtime until it is closed, and emits what the real library would: `add` when the file is first seen and again when it comes back, `change` when the mtime moves (or when the file can be looked at again after an `error`), `unlink` when the file is gone, and `error` (once, until it can be looked at again) when it cannot be looked at. A server that does not answer says nothing.

import { databaseRequest } from './database-request'

const POLL_INTERVAL = 2000

export const watch = (path) => {
  const handlers = { add: [], change: [], unlink: [], error: [] }
  const emit = (event, ...args) => handlers[event].forEach((handler) => handler(...args))

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

  // `present` is whether the file was there at the last look (null before the first), `failing` that the last look could not tell.
  let lastModified = null
  let present = null
  let failing = false

  const poll = () => databaseRequest(`/stat?path=${encodeURIComponent(path)}`).then(async (response) => ({ response, body: await response.json().catch(() => null) })).then(({ response, body }) => {
    if (closed || !body) {
      return
    }

    if (body.missing) {
      if (present === true) {
        emit('unlink', path)
      }

      present = false
      failing = false
      lastModified = null

      return
    }

    if (!response.ok) {
      if (!failing) {
        emit('error', new Error(body.error || 'The save could not be looked at'))
      }

      failing = true

      return
    }

    if (present !== true) {
      emit('add', path, {})
    } else if (failing || body.mtimeMs !== lastModified) {
      emit('change', path, {})
    }

    present = true
    failing = false
    lastModified = body.mtimeMs
  }).catch(() => {}).finally(() => {
    if (!closed) {
      timer = setTimeout(poll, POLL_INTERVAL)
    }
  })

  poll()

  return watcher
}

export default { watch }
