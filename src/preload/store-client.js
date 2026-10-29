// The window's `electron-store`: the same calls (`get`, `set`, `delete`, `has`, `clear`, `store`, `path`), each answered by the main process (src/main/store-host.js) over a synchronous request, so call sites keep their shape while every read and write of a file is made there, one at a time, for every window. `update` is the one call that is new: a read-change-write of the whole file that cannot lose another window's write in between.

const ATTEMPTS = 50

// The store class over `send(request)`, which returns the host's answer. `options` of a store are `{ cwd, name }` as electron-store's: nothing else is supported.
export const createStoreClient = (send) => class RemoteStore {
  constructor (options = {}) {
    this.target = { cwd: options.cwd, name: options.name }
    this.location = null
  }

  call (op, ...args) {
    const answer = send({ ...this.target, op, args })

    if (!answer || !answer.ok) {
      throw Object.assign(new Error((answer && answer.message) || 'The settings store did not answer'), answer && answer.code ? { code: answer.code } : {})
    }

    return answer.value
  }

  get path () {
    if (this.location === null) {
      this.location = this.call('path')
    }

    return this.location
  }

  get (key, fallback) {
    return this.call('get', key, fallback)
  }

  has (key) {
    return this.call('has', key)
  }

  set (key, value) {
    this.call('set', key, value)
  }

  delete (key) {
    this.call('delete', key)
  }

  clear () {
    this.call('clear')
  }

  get store () {
    return this.call('read')
  }

  set store (value) {
    this.call('write', value)
  }

  // Changes the whole store as `change(store)` says (it returns the next store, from a copy it may change) and writes it only when no other write came between the read and the write: otherwise the change is made again over what is stored now. A `change` that throws writes nothing. `companion(next)` may return { store, key, value }, a value of another store that belongs to this write (the undo of an import): it is written by the same request that writes `next`, so it is written for the change that was kept and for no other.
  update (change, companion) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const base = JSON.stringify(this.call('read'))
      const next = change(JSON.parse(base))
      const also = companion ? companion(next) : null

      if (this.call('swap', base, next, also ? { ...also.store.target, key: also.key, value: also.value } : undefined)) {
        return next
      }
    }

    throw new Error('The settings kept changing in another window, so nothing was written')
  }
}
