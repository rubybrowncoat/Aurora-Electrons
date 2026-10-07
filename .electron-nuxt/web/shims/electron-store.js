// Web mode stand-in for `electron-store`: dot-path get/set/onDidChange and the
// whole `store`, persisted in localStorage. Each store (`cwd` and `name`,
// default 'config' as in electron-store) gets its own key, like
// electron-store's separate files.

const listeners = {}

const read = (storageKey) => {
  try {
    return JSON.parse(localStorage.getItem(storageKey)) || {}
  } catch (e) {
    return {}
  }
}

// Settings writes swallow a failure (storage unavailable: they last for the page only). Whole-store
// writes, which hold the recorder's history, don't, like electron-store's throw on a failed write.
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

export default class Store {
  constructor (options = {}) {
    this.storageKey = `aurora-electrons:${options.cwd ? `${options.cwd}/` : ''}${options.name || 'config'}`
    this.path = `localStorage ${this.storageKey}`
  }

  get store () {
    return read(this.storageKey)
  }

  set store (value) {
    write(this.storageKey, value, { strict: true })
  }

  get (key, defaultValue) {
    const value = getPath(read(this.storageKey), key)

    return value === undefined ? defaultValue : value
  }

  set (key, value) {
    const store = read(this.storageKey)
    const oldValue = getPath(store, key)

    setPath(store, key, value)
    write(this.storageKey, store)

    const listenerKey = `${this.storageKey}:${key}`

    ;(listeners[listenerKey] || []).forEach((callback) => callback(value, oldValue))
  }

  onDidChange (key, callback) {
    const listenerKey = `${this.storageKey}:${key}`

    listeners[listenerKey] = [...(listeners[listenerKey] || []), callback]

    return () => {
      listeners[listenerKey] = listeners[listenerKey].filter((listener) => listener !== callback)
    }
  }
}
