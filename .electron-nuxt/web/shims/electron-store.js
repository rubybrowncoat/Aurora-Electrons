// Web mode stand-in for `electron-store`: dot-path get/set/onDidChange,
// persisted in localStorage.

const STORAGE_KEY = 'aurora-electrons:config'

const listeners = {}

const read = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}
  } catch (e) {
    return {}
  }
}

const write = (store) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch (e) {
    // Storage unavailable: settings last for the page only.
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
  get (key, defaultValue) {
    const value = getPath(read(), key)

    return value === undefined ? defaultValue : value
  }

  set (key, value) {
    const store = read()
    const oldValue = getPath(store, key)

    setPath(store, key, value)
    write(store)

    ;(listeners[key] || []).forEach((callback) => callback(value, oldValue))
  }

  onDidChange (key, callback) {
    listeners[key] = [...(listeners[key] || []), callback]

    return () => {
      listeners[key] = listeners[key].filter((listener) => listener !== callback)
    }
  }
}
