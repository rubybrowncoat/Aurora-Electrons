/*
  Web mode only: serves the renderer's database calls from Node. The browser shim (shims/database.js) posts raw queries and read-only model calls here; they run against the real Sequelize models from src/renderer/utilities/database.js.

  It executes arbitrary SQL against the save, so it only answers the web-mode page itself: a localhost Host header (no DNS rebinding), a same-origin request, a JSON body, and the per-run token web.js embeds in the page.
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Model } = require('sequelize')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const STORAGE_PATH = path.resolve(PROJECT_ROOT, process.env.AURORA_DB || 'AuroraDB.db')
// The saves the page may switch to, besides the one the server started on: AURORA_DB_SAVES lists more, separated as PATH is. The server runs real SQL on whatever it opens, so it opens only these.
const ALLOWED_SAVES = [STORAGE_PATH, ...String(process.env.AURORA_DB_SAVES || '').split(path.delimiter).filter(Boolean).map((file) => path.resolve(PROJECT_ROOT, file))]
const MODEL_METHODS = new Set(['findAll', 'findOne', 'findByPk', 'count', 'findAndCountAll'])
const INSTANCE_INTERNALS = new Set(['dataValues', '_previousDataValues', 'uniqno', '_changed', '_options', 'isNewRecord'])
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const TOKEN = crypto.randomBytes(32).toString('hex')
const TOKEN_HEADER = 'x-aurora-web-token'

class HttpError extends Error {
  constructor (status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

let loadDatabaseModule = null

// One connection for each copy of a save a page opened: `/reset` opens one and answers its token, every query and model call names the token it is for, and `/release` retires it (the way the app retires a replaced database, so what is still queued on it is refused as retired). A tab that switches to another save, or opens its own copy again, never changes what another tab's calls read. A call for a copy the page released is answered 409 with `superseded`, which the page treats as the old copy's refusal. A call for a token the server no longer has but the page did not release (the copy was pushed out by the bound, or the server restarted) is answered 409 with `expired`: the page's current copy is lost, and it opens the save again. The bound pushes out the least recently used copy that is idle, never one with a call running; pages release their copies when they close (the shim's `pagehide`).
const MAX_CONNECTIONS = 16
const RELEASED_KEPT = 4096
const connections = new Map()
const released = new Set()
let tick = 0

const retire = async (database) => {
  const { retireDatabase } = await loadDatabaseModule()

  await retireDatabase(database)
}

const open = async (storagePath) => {
  const { resetDatabase } = await loadDatabaseModule()
  const database = resetDatabase(storagePath)
  const token = crypto.randomBytes(12).toString('hex')

  database.options.logging = false
  connections.set(token, { database, path: storagePath, busy: 0, used: ++tick })

  while (connections.size > MAX_CONNECTIONS) {
    const idle = [...connections].filter(([other, connection]) => other !== token && connection.busy === 0).sort((one, two) => one[1].used - two[1].used)

    if (!idle.length) {
      break
    }

    const [oldest, connection] = idle[0]

    connections.delete(oldest)
    retire(connection.database)
  }

  return token
}

const release = async (token) => {
  const connection = connections.get(token)

  connections.delete(token)
  released.add(token)

  if (released.size > RELEASED_KEPT) {
    released.delete(released.values().next().value)
  }

  if (connection) {
    await retire(connection.database)
  }
}

// Runs `work(database)` on the copy `token` names. A copy that was released, or is retiring while the call runs, answers as superseded however its statement failed.
const withConnection = async (token, work) => {
  const connection = typeof token === 'string' ? connections.get(token) : null

  if (!connection) {
    throw released.has(token) ? new HttpError(409, 'This copy of the save was replaced or closed.', { superseded: true }) : new HttpError(409, 'This copy of the save is no longer open on the server.', { expired: true })
  }

  connection.busy++
  connection.used = ++tick

  try {
    return await work(connection.database)
  } catch (error) {
    if (released.has(token) || (error && error.retired)) {
      throw new HttpError(409, 'This copy of the save was replaced or closed.', { superseded: true })
    }

    throw error
  } finally {
    connection.busy--
    connection.used = ++tick
  }
}

const decode = (value, database) => {
  if (Array.isArray(value)) {
    return value.map((entry) => decode(entry, database))
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
    decoded[key.startsWith('__symbol:') ? Symbol.for(key.slice(9)) : key] = decode(entry, database)

    return decoded
  }, {})
}

// Instances become plain objects. Own properties set outside dataValues (e.g. by the Contact afterFind hook) are kept too.
const serialize = (value) => {
  if (Array.isArray(value)) {
    return value.map(serialize)
  }

  if (value instanceof Model) {
    const plain = value.get({ plain: true })

    Object.keys(value).filter((key) => !INSTANCE_INTERNALS.has(key) && !(key in plain)).forEach((key) => {
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

const unavailableReason = (file) => (fs.existsSync(file) ? null : 'the file does not exist')

const saveEntry = (file, active) => {
  const reason = unavailableReason(file)

  return {
    path: file,
    name: path.basename(file),
    folder: path.dirname(file),
    openedAt: null,
    state: reason ? 'unavailable' : 'available',
    reason,
    active: file === active,
    openElsewhere: false,
  }
}

// The page says which save it shows (in the desktop app the main process knows, per window). What the main process's save service answers (src/main/saves.js), for the saves this server allows.
const savesState = (active) => {
  const reason = unavailableReason(active)

  return {
    active: { path: active, state: reason ? 'unavailable' : 'available', reason },
    limit: ALLOWED_SAVES.length,
    error: null,
    recent: ALLOWED_SAVES.map((file) => saveEntry(file, active)),
  }
}

// Whether a page showing `active` may switch to `requested`; the page keeps the answer.
const savesSelect = (requested, active) => {
  const file = typeof requested === 'string' ? path.resolve(requested) : ''
  const reason = unavailableReason(file)

  if (!ALLOWED_SAVES.includes(file)) {
    return { ok: false, action: 'unavailable', path: requested, active, reason: 'web mode opens only the saves the server was started with' }
  } else if (file === active) {
    return { ok: true, action: 'unchanged', path: file, active }
  } else if (reason) {
    return { ok: false, action: 'unavailable', path: file, active, reason }
  }

  return { ok: true, action: 'switched', path: file, active: file }
}

// The path of a save on the allow-list, whether or not the file is there.
const listedSave = (requested) => {
  const file = typeof requested === 'string' ? path.resolve(requested) : ''

  if (!ALLOWED_SAVES.includes(file)) {
    throw new HttpError(400, 'Web mode opens only the saves the server was started with.')
  }

  return file
}

const allowedSave = (requested) => {
  const file = listedSave(requested)

  if (!fs.existsSync(file)) {
    throw new HttpError(503, `No database at ${file}. Run \`unzip fixtures/AuroraDB.zip\`.`)
  }

  return file
}

const routes = {
  // The file's modification time, or `missing` when the file is not there; a file that cannot be looked at (locked, no permission) is answered 503 with the reason. The page's watcher reads these as add, change, unlink and error.
  'GET /stat': async (_body, req) => {
    const file = listedSave(new URL(req.url, 'http://localhost').searchParams.get('path'))

    try {
      return { mtimeMs: fs.statSync(file).mtimeMs }
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        return { missing: true }
      }

      throw new HttpError(503, String(error.message).split(/\r?\n/)[0])
    }
  },

  // Opens a new copy of an allowed save for this page; the answer names it.
  'POST /reset': async ({ storagePath }) => {
    const file = allowedSave(storagePath)

    return { storagePath: file, token: await open(file) }
  },

  'POST /release': async ({ token }) => {
    await release(token)

    return { released: true }
  },

  'POST /saves': async ({ op, path: requested, active }) => {
    switch (op) {
      case 'launch':
        return STORAGE_PATH
      case 'state':
        return savesState(typeof active === 'string' ? active : STORAGE_PATH)
      case 'select':
        return savesSelect(requested, typeof active === 'string' ? active : STORAGE_PATH)
      case 'forget':
        return { ok: true, action: 'forgotten', path: requested }
      default:
        throw new HttpError(400, 'Expected { op: launch | state | select | forget }.')
    }
  },

  'POST /query': async ({ token, sql, options }) => withConnection(token, (database) => {
    if (typeof sql !== 'string') {
      throw new HttpError(400, 'Expected { token, sql, options }.')
    }

    return database.query(sql, decode(options || {}, database))
  }),

  'POST /model': async ({ token, model, scopes, method, args }) => withConnection(token, async (database) => {
    if (!MODEL_METHODS.has(method)) {
      throw new HttpError(400, `Model method not available in web mode: ${method}`)
    }

    if (!Object.prototype.hasOwnProperty.call(database.models, model) || !Array.isArray(scopes) || !Array.isArray(args)) {
      throw new HttpError(400, 'Expected { token, model, scopes: [], method, args: [] } for a known model.')
    }

    const target = scopes.length ? database.models[model].scope(...scopes) : database.models[model]

    return serialize(await target[method](...decode(args, database)))
  }),
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

    send(res, 200, await route(req.method === 'POST' ? await readBody(req) : {}, req))
  } catch (error) {
    if (!error.status) {
      console.error('[web] database error', error)
    }

    send(res, error.status || 500, { error: error.message, ...error.extra })
  }
}

// The handler for /__aurora-db. `load` imports src/renderer/utilities/database.js: web.js has Vite load it, which resolves its imports the way the renderer build does.
const databaseHandler = (load) => {
  loadDatabaseModule = load

  return handleDatabase
}

module.exports = { TOKEN, TOKEN_HEADER, guardHost, databaseHandler }
