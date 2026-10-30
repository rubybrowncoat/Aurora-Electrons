// Web mode stand-in for src/renderer/utilities/database.js.
// Same surface the pages use (`query` and `models.X.find*`), backed by the dev server's database middleware instead of an in-process Sequelize.

import { DatabaseRetired } from '../../../src/renderer/utilities/retired'

import { databaseRequest } from './database-request'
import { tracked } from './pending-reads'
import { webError } from './web-error'

const modelStubs = new WeakSet()

const encode = (value) => {
  if (Array.isArray(value)) {
    return value.map(encode)
  }

  if (typeof value === 'symbol') {
    return { __symbol: Symbol.keyFor(value) }
  }

  if (modelStubs.has(value)) {
    return { __model: value.name, __scopes: value.scopes }
  }

  if (value === null || typeof value !== 'object' || value instanceof Date) {
    return value
  }

  const encoded = {}

  Object.keys(value).forEach((key) => {
    encoded[key] = encode(value[key])
  })

  Object.getOwnPropertySymbols(value).forEach((symbol) => {
    encoded[`__symbol:${Symbol.keyFor(symbol)}`] = encode(value[symbol])
  })

  return encoded
}

// The server no longer has the copy this page opened and the page did not release it (it was pushed out, or the server restarted). Unlike a released copy, this is the page's current copy being lost: the app opens the save again (plugins/database.js listens for `aurora:database-lost`). Callers that see it drop their answer like any retired one.
class DatabaseExpired extends DatabaseRetired {
  constructor () {
    super()
    this.name = 'DatabaseExpired'
    this.expired = true
  }
}

const send = async (route, payload) => {
  const response = await databaseRequest(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json()

  if (!response.ok) {
    // The server closed or replaced the copy this page opened: the same refusal as a replaced database in the app.
    if (body && body.superseded) {
      throw new DatabaseRetired()
    } else if (body && body.expired) {
      throw new DatabaseExpired()
    }

    throw webError(route, body)
  }

  return body
}

// What a call asks, for the label of a wait that is told what it waited for: the statement of a query, the model and method of a model call, the route of any other.
const labelOf = (route, payload) => `${route}${payload && payload.sql ? ` ${String(payload.sql).replace(/\s+/g, ' ')}` : ''}${payload && payload.model ? ` ${payload.model}.${payload.method}` : ''}`

const request = (route, payload) => tracked(labelOf(route, payload), () => send(route, payload))

// Pages call `toJSON()`/`get()` on results, so give plain objects that much of the Sequelize instance API.
const instanceMethods = {
  toJSON () {
    return { ...this }
  },
  get (key) {
    return typeof key === 'string' ? this[key] : { ...this }
  },
}

const hydrate = (value) => {
  if (Array.isArray(value)) {
    value.forEach(hydrate)
  } else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(hydrate)
    Object.keys(instanceMethods).forEach((name) => {
      Object.defineProperty(value, name, { value: instanceMethods[name], enumerable: false })
    })
  }

  return value
}

const makeModel = (ready, guard, name, scopes = []) => {
  const call = (method) => (...args) => guard(ready.then(({ token }) => request('/model', { token, model: name, scopes, method, args: encode(args) }))).then(hydrate)

  const model = {
    name,
    scopes,
    scope: (...names) => makeModel(ready, guard, name, names.flat()),
    findAll: call('findAll'),
    findOne: call('findOne'),
    findByPk: call('findByPk'),
    count: call('count'),
    findAndCountAll: call('findAndCountAll'),
  }

  modelStubs.add(model)

  return model
}

// The copy each database of this page stands for, by its token at the dev server, and the tokens of the copies this page has open: they are released when the page goes away, so a closed tab never holds a connection (and never pushes out a live tab's).
const opened = new WeakMap()
const live = new Set()

window.addEventListener('pagehide', () => {
  live.forEach((token) => {
    databaseRequest('/release', { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).catch(() => {})
  })
})

// Closes the copy at the dev server (nothing else of the page or of another tab reads it).
export const retireDatabase = async (database) => {
  const ready = database && opened.get(database)

  if (ready) {
    await ready.then(({ token }) => {
      live.delete(token)

      return request('/release', { token })
    }).catch(() => {})
  }
}

export const resetDatabase = (storagePath) => {
  console.log('## [web] RESETTING ON', storagePath)

  const ready = request('/reset', { storagePath })
  const models = {}
  const guard = (promise) => promise.catch((error) => {
    if (error.expired) {
      window.dispatchEvent(new CustomEvent('aurora:database-lost', { detail: { database } }))
    }

    throw error
  })

  ready.then(({ token }) => live.add(token), () => {})

  const database = {
    // A transaction is only a pass-through here: reads in it aren't a single snapshot, and the `transaction` option never goes over the wire.
    transaction: (work) => work({}),
    query: (sql, { transaction: _transaction, ...options } = {}) => guard(ready.then(({ token }) => request('/query', { token, sql, options: encode(options) }))),
    models: new Proxy(models, {
      get: (cache, name) => {
        if (typeof name !== 'string') {
          return undefined
        }

        if (!cache[name]) {
          cache[name] = makeModel(ready, guard, name)
        }

        return cache[name]
      },
    }),
  }

  opened.set(database, ready)

  return database
}
