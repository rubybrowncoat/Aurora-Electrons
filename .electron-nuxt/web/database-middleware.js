/*
  Web mode only: serves the renderer's database calls from Node.
  The browser shim (shims/database.js) posts raw queries and read-only model
  calls here; they run against the real Sequelize models from
  src/renderer/utilities/database.js.
 */
const fs = require('fs')
const path = require('path')
const { Model } = require('sequelize')
const jiti = require('jiti')(__filename)
const { PROJECT_ROOT, RENDERER_PROCESS_DIR } = require('../config')

const { resetDatabase } = jiti(path.join(RENDERER_PROCESS_DIR, 'utilities/database.js'))

const STORAGE_PATH = path.resolve(PROJECT_ROOT, process.env.AURORA_DB || 'AuroraDB.db')
const MODEL_METHODS = new Set(['findAll', 'findOne', 'findByPk', 'count', 'findAndCountAll'])
const INSTANCE_INTERNALS = new Set(['dataValues', '_previousDataValues', 'uniqno', '_changed', '_options', 'isNewRecord'])

let database = null
let opening = null

const open = () => {
  opening = (async () => {
    if (database) {
      await database.close()
    }

    database = resetDatabase(STORAGE_PATH)
    database.options.logging = false
  })()

  return opening
}

const decode = (value) => {
  if (Array.isArray(value)) {
    return value.map(decode)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  if ('__symbol' in value) {
    return Symbol.for(value.__symbol)
  }

  if ('__model' in value) {
    const model = database.models[value.__model]

    return value.__scopes.length ? model.scope(...value.__scopes) : model
  }

  return Object.entries(value).reduce((decoded, [key, entry]) => {
    decoded[key.startsWith('__symbol:') ? Symbol.for(key.slice(9)) : key] = decode(entry)

    return decoded
  }, {})
}

// Instances become plain objects. Own properties set outside dataValues (e.g. by
// the Contact afterFind hook) are kept too.
const serialize = (value) => {
  if (Array.isArray(value)) {
    return value.map(serialize)
  }

  if (value instanceof Model) {
    const plain = value.get({ plain: true })

    Object.keys(value)
      .filter((key) => !INSTANCE_INTERNALS.has(key) && !(key in plain))
      .forEach((key) => {
        plain[key] = serialize(value[key])
      })

    return plain
  }

  return value
}

const readBody = (req) => new Promise((resolve, reject) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => resolve(body ? JSON.parse(body) : {}))
  req.on('error', reject)
})

const send = (res, status, payload) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload === undefined ? null : payload))
}

const routes = {
  'GET /stat': async () => ({ mtimeMs: fs.statSync(STORAGE_PATH).mtimeMs }),

  'POST /reset': async () => {
    await open()

    return { storagePath: STORAGE_PATH }
  },

  'POST /query': async ({ sql, options }) => database.query(sql, decode(options || {})),

  'POST /model': async ({ model, scopes, method, args }) => {
    if (!MODEL_METHODS.has(method)) {
      throw new Error(`Model method not available in web mode: ${method}`)
    }

    const target = scopes.length ? database.models[model].scope(...scopes) : database.models[model]

    return serialize(await target[method](...decode(args)))
  },
}

module.exports = async (req, res) => {
  const route = routes[`${req.method} ${req.url.split('?')[0]}`]

  if (!route) {
    return send(res, 404, { error: `No web-mode route for ${req.method} ${req.url}` })
  }

  try {
    if (!fs.existsSync(STORAGE_PATH)) {
      return send(res, 503, { error: `No database at ${STORAGE_PATH}. Run \`unzip fixtures/AuroraDB.zip\`.` })
    }

    await (opening || open())

    send(res, 200, await route(req.method === 'POST' ? await readBody(req) : {}))
  } catch (error) {
    console.error('[web] database error', error)
    send(res, 500, { error: error.message })
  }
}
