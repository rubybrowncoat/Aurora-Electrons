// The one place the app's settings and history files are read and written. Every window of the app (one per database) asks this over a synchronous IPC (src/preload/store-client.js), and the main process runs the requests one at a time, so a read-change-write of a file is never interleaved with another window's. A store in each window's own process would read the whole file, change it and replace it, and two windows writing at once would drop each other's keys.

const UNSAFE_SEGMENTS = ['__proto__', 'constructor', 'prototype']

// Sets the value at a dot path in plain objects. electron-store's own `set` makes an array of a group whose next segment is a number (`race.784` becomes a list of 785 slots), and the app reads its settings as objects (`campaign.<id>.race.<RaceID>`, `game.<GameID>`).
const setPath = (target, key, value) => {
  const parts = String(key).split('.')

  if (parts.some((part) => UNSAFE_SEGMENTS.includes(part))) {
    throw new Error(`The key ${key} is not allowed`)
  }

  const last = parts.pop()
  let node = target

  parts.forEach((part) => {
    if (node[part] === null || typeof node[part] !== 'object') {
      node[part] = {}
    }

    node = node[part]
  })
  node[last] = value
}

// Sets `value` at the dot path `key` of a store, in plain objects.
const put = (store, key, value) => {
  if (value === undefined) {
    throw new TypeError('Use `delete()` to clear values')
  }

  const next = store.store

  setPath(next, key, value)
  store.store = next
}

// What the caller is told of a failure; a file that is not valid JSON is named, as the parser's own message names nothing.
const messageOf = (error, request) => {
  const message = error && error.message ? String(error.message) : String(error)

  return error instanceof SyntaxError ? `The settings file ${request.cwd ? `${request.cwd}/` : ''}${request.name || 'config'}.json is damaged and could not be read (${message})` : message
}

// `open(options)` opens the store of one file (electron-store's, in the app) from `{ cwd, name }`, the folder under the user-data folder and the name, each present only when the window gave it. The host keeps one store per file.
export const createStoreHost = (open) => {
  const stores = new Map()

  const storeOf = ({ cwd, name }) => {
    const key = `${cwd || ''}/${name || 'config'}`

    if (!stores.has(key)) {
      stores.set(key, open({ ...(cwd ? { cwd } : {}), ...(name ? { name } : {}) }))
    }

    return stores.get(key)
  }

  const operations = {
    get: (store, [key, fallback]) => store.get(key, fallback),
    has: (store, [key]) => store.has(key),
    set: (store, [key, value]) => {
      put(store, key, value)
    },
    delete: (store, [key]) => {
      store.delete(key)
    },
    clear: (store) => {
      store.clear()
    },
    read: (store) => store.store,
    write: (store, [value]) => {
      store.store = value
    },
    path: (store) => store.path,
    // Writes `next` only when the file still holds what `base` (its JSON) says it held when the caller read it: a read-change-write of the whole file by a caller that reads, changes and asks again if this refuses. `also` is { cwd, name, key, value }, a value of another file (the undo kept for an import) that belongs to this write: it is written in the same request, after the compare and never when it refuses, and if it cannot be written this file is put back as it was and the error is thrown.
    swap: (store, [base, next, also]) => {
      if (JSON.stringify(store.store) !== base) {
        return false
      }

      store.store = next

      if (also) {
        try {
          put(storeOf(also), also.key, also.value)
        } catch (error) {
          store.store = JSON.parse(base)

          // The failure is of the companion file: it is named as such, and this file, put back, is not called damaged by the answer.
          throw Object.assign(new Error(messageOf(error, also)), error && error.code ? { code: error.code } : {})
        }
      }

      return true
    },
  }

  // `request` is { cwd, name, op, args }; the answer is { ok: true, value } or { ok: false, message, code }, never a throw, for the caller to rethrow where it asked.
  const handle = (request) => {
    try {
      const operation = Object.prototype.hasOwnProperty.call(operations, request.op) ? operations[request.op] : null

      if (!operation) {
        throw new Error(`The settings store has no operation ${String(request.op)}`)
      }

      return { ok: true, value: operation(storeOf(request), Array.isArray(request.args) ? request.args : []) }
    } catch (error) {
      return { ok: false, message: messageOf(error, request), code: error && error.code ? String(error.code) : undefined }
    }
  }

  // `store(options)` is the store of one file for the main process's own use (the recent saves): the same instance the windows' requests reach.
  return { handle, store: storeOf }
}
