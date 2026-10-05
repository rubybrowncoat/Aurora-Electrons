/*
  Web mode only: serves the renderer's database calls from Node.
  The browser shim (shims/database.js) posts raw queries and read-only model
  calls here; they run against the real Sequelize models from
  src/renderer/utilities/database.js.

  It executes arbitrary SQL against the save, so it only answers the web-mode
  page itself: a localhost Host header (no DNS rebinding), a same-origin
  request, a JSON body, and the per-run token web.js embeds in the page.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Model } = require('sequelize')
const jiti = require('jiti')(__filename)
const { PROJECT_ROOT, RENDERER_PROCESS_DIR } = require('../config')

const { resetDatabase } = jiti(path.join(RENDERER_PROCESS_DIR, 'utilities/database.js'))

const STORAGE_PATH = path.resolve(PROJECT_ROOT, process.env.AURORA_DB || 'AuroraDB.db')
const MODEL_METHODS = new Set(['findAll', 'findOne', 'findByPk', 'count', 'findAndCountAll'])
const INSTANCE_INTERNALS = new Set(['dataValues', '_previousDataValues', 'uniqno', '_changed', '_options', 'isNewRecord'])
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const TOKEN = crypto.randomBytes(32).toString('hex')
const TOKEN_HEADER = 'x-aurora-web-token'

class HttpError extends Error {
  constructor (status, message) {
    super(message)
    this.status = status
  }
}

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

const isLocalHost = (req) => LOCAL_HOSTNAMES.has((req.headers.host || '').replace(/:\d+$/, ''))

const isSameOrigin = (req) => {
  const { origin } = req.headers
  const site = req.headers['sec-fetch-site']

  return (!origin || origin === `http://${req.headers.host}`) && (!site || site === 'same-origin' || site === 'none')
}

const hasToken = (req) => {
  const token = Buffer.from(String(req.headers[TOKEN_HEADER] || ''))
  const expected = Buffer.from(TOKEN)

  return token.length === expected.length && crypto.timingSafeEqual(token, expected)
}

const readBody = (req) => new Promise((resolve, reject) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    let parsed

    try {
      parsed = body ? JSON.parse(body) : {}
    } catch (error) {
      return reject(new HttpError(400, 'Request body is not valid JSON.'))
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return reject(new HttpError(400, 'Request body must be a JSON object.'))
    }

    resolve(parsed)
  })
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

  'POST /query': async ({ sql, options }) => {
    if (typeof sql !== 'string') {
      throw new HttpError(400, 'Expected { sql, options }.')
    }

    return database.query(sql, decode(options || {}))
  },

  'POST /model': async ({ model, scopes, method, args }) => {
    if (!MODEL_METHODS.has(method)) {
      throw new HttpError(400, `Model method not available in web mode: ${method}`)
    }

    if (!Object.prototype.hasOwnProperty.call(database.models, model) || !Array.isArray(scopes) || !Array.isArray(args)) {
      throw new HttpError(400, 'Expected { model, scopes: [], method, args: [] } for a known model.')
    }

    const target = scopes.length ? database.models[model].scope(...scopes) : database.models[model]

    return serialize(await target[method](...decode(args)))
  },
}

// Runs for every web-mode route, page included, because the page carries the token.
const guardHost = (req, res, next) => {
  if (!isLocalHost(req)) {
    res.statusCode = 403

    return res.end('Web mode only answers requests addressed to localhost.')
  }

  next()
}

const handleDatabase = async (req, res) => {
  try {
    if (!isSameOrigin(req) || !hasToken(req)) {
      throw new HttpError(403, 'Web-mode database calls must come from the web-mode page.')
    }

    const route = routes[`${req.method} ${req.url.split('?')[0]}`]

    if (!route) {
      throw new HttpError(404, `No web-mode route for ${req.method} ${req.url}`)
    }

    if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      throw new HttpError(415, 'Web-mode database calls must send JSON.')
    }

    if (!fs.existsSync(STORAGE_PATH)) {
      throw new HttpError(503, `No database at ${STORAGE_PATH}. Run \`unzip fixtures/AuroraDB.zip\`.`)
    }

    await (opening || open())

    send(res, 200, await route(req.method === 'POST' ? await readBody(req) : {}))
  } catch (error) {
    if (!error.status) {
      console.error('[web] database error', error)
    }

    send(res, error.status || 500, { error: error.message })
  }
}

module.exports = { TOKEN, TOKEN_HEADER, guardHost, handleDatabase }
