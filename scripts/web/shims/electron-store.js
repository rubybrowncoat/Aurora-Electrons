// Web mode stand-in for `electron-store`: dot-path get/set/delete/onDidChange and the whole `store`, persisted in localStorage. Each store (`cwd` and `name`, default 'config' as in electron-store) gets its own key, like electron-store's separate files.

const listeners = {}

// What the store holds, as a plain read. An absent value, storage the browser does not let the page read, or a value that is not valid JSON (or is JSON null, false or 0) reads as an empty store, which the app's settings and history readers depend on to start. A store opened with `strict: true` (a writer of whole files that must never replace one it could not read: utilities/scenario-records.js) reads as electron-store's does instead: a present value that is not valid JSON throws, naming the store, and a present value is returned as parsed, whatever it is, for the caller's own shape check to refuse; only an absent value, or storage the browser does not let the page read, is empty.
const read = (storageKey, strict = false) => {
  let raw = null

  try {
    raw = localStorage.getItem(storageKey)
  } catch (e) {
    return {}
  }

  if (raw === null) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw)

    return strict ? parsed : (parsed || {})
  } catch (e) {
    if (strict) {
      throw new Error(`The settings file ${storageKey} is damaged and could not be read (${e.message})`)
    }

    return {}
  }
}

// Settings writes swallow a failure (storage unavailable: they last for the page only). Whole-store writes, which hold the recorder's history, don't, like electron-store's throw on a failed write.
const write = (storageKey, store, { strict = false } = {}) => {
  try {
    localStorage.setItem(storageKey, JSON.stringify(store))
  } catch (e) {
    if (strict) {
      throw e
    }
  }
}

const getPath = (object, key) => key.split('.').reduce((node, part) => (node !== null && typeof node === 'object' ? node[part] : undefined), object)

const setPath = (object, key, value) => {
  const parts = key.split('.')
  const last = parts.pop()
  const parent = parts.reduce((node, part) => {
    if (node[part] === null || typeof node[part] !== 'object') {
      node[part] = {}
    }

    return node[part]
  }, object)

  parent[last] = value
}

const deletePath = (object, key) => {
  const parts = key.split('.')
  const last = parts.pop()
  const parent = parts.length ? getPath(object, parts.join('.')) : object

  if (parent !== null && typeof parent === 'object') {
    delete parent[last]
  }
}

export default class Store {
  constructor (options = {}) {
    this.storageKey = `aurora-electrons:${options.cwd ? `${options.cwd}/` : ''}${options.name || 'config'}`
    this.path = `localStorage ${this.storageKey}`
    this.strict = options.strict === true
  }

  get store () {
    return read(this.storageKey, this.strict)
  }

  set store (value) {
    write(this.storageKey, value, { strict: true })
  }

  // A read-change-write of the whole store: `change(store)` returns the next one, and `companion(next)` may return { store, key, value } for a value of another store that goes with it. The app's `update`; the page's one thread makes it atomic here.
  update (change, companion) {
    const next = change(this.store)
    const also = companion ? companion(next) : null

    this.store = next

    if (also) {
      also.store.set(also.key, also.value)
    }

    return next
  }

  get (key, defaultValue) {
    const value = getPath(read(this.storageKey, this.strict), key)

    return value === undefined ? defaultValue : value
  }

  set (key, value) {
    const store = read(this.storageKey, this.strict)
    const oldValue = getPath(store, key)

    setPath(store, key, value)
    write(this.storageKey, store)

    const listenerKey = `${this.storageKey}:${key}`

    ;(listeners[listenerKey] || []).forEach((callback) => callback(value, oldValue))
  }

  delete (key) {
    const store = read(this.storageKey, this.strict)
    const oldValue = getPath(store, key)

    deletePath(store, key)
    write(this.storageKey, store)

    const listenerKey = `${this.storageKey}:${key}`

    ;(listeners[listenerKey] || []).forEach((callback) => callback(undefined, oldValue))
  }

  onDidChange (key, callback) {
    const listenerKey = `${this.storageKey}:${key}`

    listeners[listenerKey] = [...(listeners[listenerKey] || []), callback]

    return () => {
      listeners[listenerKey] = listeners[listenerKey].filter((listener) => listener !== callback)
    }
  }
}

// The tabs of one browser share localStorage and `update` is not a compare-and-swap between them (another tab can write between its read and its write), so a writer of whole files that must not lose a write (utilities/scenario-records.js) lets one tab at a time write.
Store.writesNeedOwner = true
