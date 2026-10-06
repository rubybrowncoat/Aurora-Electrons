// Web mode stand-in for src/renderer/utilities/database.js.
// Same surface the pages use (`query` and `models.X.find*`), backed by the
// dev server's database middleware instead of an in-process Sequelize.

import { databaseRequest } from './database-request'

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

const request = async (route, payload) => {
  const response = await databaseRequest(route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json()

  if (!response.ok) {
    throw new Error(`[web] ${route}: ${body && body.error}`)
  }

  return body
}

// Pages call `toJSON()`/`get()` on results, so give plain objects that much of
// the Sequelize instance API.
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

const makeModel = (ready, name, scopes = []) => {
  const call = (method) => (...args) => ready.then(() => request('/model', { model: name, scopes, method, args: encode(args) })).then(hydrate)

  const model = {
    name,
    scopes,
    scope: (...names) => makeModel(ready, name, names.flat()),
    findAll: call('findAll'),
    findOne: call('findOne'),
    findByPk: call('findByPk'),
    count: call('count'),
    findAndCountAll: call('findAndCountAll'),
  }

  modelStubs.add(model)

  return model
}

export const resetDatabase = (storagePath) => {
  console.log('## [web] RESETTING ON', storagePath)

  const ready = request('/reset', {})
  const models = {}

  return {
    // The middleware shares one connection, so a transaction is only a pass-through here: reads in
    // it aren't a single snapshot, and the `transaction` option never goes over the wire.
    transaction: (callback) => callback({}),
    query: (sql, { transaction, ...options } = {}) => ready.then(() => request('/query', { sql, options: encode(options) })),
    models: new Proxy(models, {
      get: (cache, name) => {
        if (typeof name !== 'string') {
          return undefined
        }

        if (!cache[name]) {
          cache[name] = makeModel(ready, name)
        }

        return cache[name]
      },
    }),
  }
}
