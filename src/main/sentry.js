import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import * as Sentry from '@sentry/electron/main'

import { version } from '../../package.json'

const DSN = 'https://8e243eff808fce8ae2da2b27f6eb4ff5@o237971.ingest.us.sentry.io/4510024176893952'
const CHANNEL = 'reporting'

export const DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 0,
}

export const redactText = (value) => String(value || '').replace(/\b(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|WITH)\b[\s\S]*/gi, '[SQL redacted]').replace(/(?:https?|file|app):\/\/[^\s)"'<>]+/gi, '[URL redacted]').replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n]*/gi, '[path redacted]').replace(/(^|[\s("'=])\/[^\r\n]*/g, '$1[path redacted]').slice(0, 1000)

// Only error/stack and app/runtime fields survive. Native attachments are binary memory and cannot be scrubbed this way.
export const minimizeEvent = (event) => {
  const frame = (item) => ({
    ...(item.filename ? { filename: String(item.filename).split(/[\\/]/).pop().split(/[?#]/)[0].slice(0, 200) } : {}),
    ...(item.function ? { function: redactText(item.function) } : {}),
    ...(Number.isInteger(item.lineno) ? { lineno: item.lineno } : {}),
    ...(Number.isInteger(item.colno) ? { colno: item.colno } : {}),
    ...(typeof item.in_app === 'boolean' ? { in_app: item.in_app } : {}),
  })
  const result = {}

  for (const key of ['event_id', 'timestamp', 'level', 'platform', 'release', 'environment']) {
    if (event[key] !== undefined) result[key] = event[key]
  }

  if (event.message) result.message = redactText(event.message)
  if (event.exception && Array.isArray(event.exception.values)) {
    result.exception = {
      values: event.exception.values.slice(0, 5).map((item) => ({
        type: redactText(item.type),
        value: redactText(item.value),
        ...(item.stacktrace ? { stacktrace: { frames: (item.stacktrace.frames || []).slice(-60).map(frame) } } : {}),
        ...(item.mechanism ? { mechanism: { type: redactText(item.mechanism.type), handled: item.mechanism.handled !== false } } : {}),
      })),
    }
  }

  if (event.contexts) {
    result.contexts = {}
    for (const [name, keys] of [['app', ['app_version']], ['runtime', ['name', 'version']]]) {
      if (event.contexts[name]) {
        result.contexts[name] = Object.fromEntries(keys.filter((key) => typeof event.contexts[name][key] === 'string').map((key) => [key, redactText(event.contexts[name][key])]))
      }
    }
  }

  if (event.tags) {
    result.tags = Object.fromEntries(['event.process', 'event.environment'].filter((key) => typeof event.tags[key] === 'string').map((key) => [key, redactText(event.tags[key])]))
  }

  return result
}

const statOrNull = (disk, file) => {
  try {
    return disk.lstatSync(file)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

// Check every ancestor, not just the leaf: a queue or Crashpad reports directory can itself be a junction.
const plainPath = (disk, file, directory = false) => {
  const absolute = path.resolve(file)
  let current = path.parse(absolute).root

  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const stat = statOrNull(disk, current)

    if (!stat) return false
    if (stat.isSymbolicLink()) throw new Error('A diagnostic path is linked; cleanup was refused')
    if (stat.isDirectory()) {
      try {
        disk.readlinkSync(current)
        throw new Error('A diagnostic directory is linked; cleanup was refused')
      } catch (error) {
        if (error.code !== 'EINVAL') throw error
      }
    }
    if (!samePath(path.resolve(disk.realpathSync(current)), current)) throw new Error('A diagnostic path escapes its directory; cleanup was refused')
  }

  const stat = disk.lstatSync(absolute)
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('A diagnostic path has an unexpected file type; cleanup was refused')
  if (!directory && stat.nlink > 1) throw new Error('A diagnostic file has hard links; cleanup was refused')
  return true
}

const reportDirectories = (platform) => platform === 'win32' ? ['reports'] : platform === 'darwin' ? ['completed', 'pending'] : ['completed']

// A stored path is not authority until its bounds, ancestors and marker all validate, even when its leaf is missing.
export const validateNativeDirectory = ({ userData, record, disk = fs, platform = process.platform }) => {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 2 || typeof record.id !== 'string' || !/^[a-f0-9]{32}$/.test(record.id) || typeof record.path !== 'string' || !path.isAbsolute(record.path)) throw new Error('The native diagnostic ownership record is invalid; reporting was refused')
  const root = path.resolve(userData)
  const directory = path.resolve(record.path)
  const relative = path.relative(root, directory)

  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !samePath(directory, record.path)) throw new Error('The native diagnostic ownership path is outside app data; reporting was refused')
  if (!plainPath(disk, root, true)) throw new Error('The app data directory is missing; reporting was refused')
  if (!plainPath(disk, directory, true)) return false
  const owner = path.join(directory, 'owner')

  if (!plainPath(disk, owner) || disk.readFileSync(owner, 'utf8') !== record.id) throw new Error('The native diagnostic owner marker does not match; reporting was refused')
  for (const name of reportDirectories(platform)) plainPath(disk, path.join(directory, name), true)
  return true
}

export const ensureNativeDirectory = ({ userData, record, saveRecord, disk = fs, platform = process.platform }) => {
  if (record !== undefined && validateNativeDirectory({ userData, record, disk, platform })) return record
  if (!plainPath(disk, userData, true)) throw new Error('The app data directory is missing; reporting was refused')
  const created = { id: crypto.randomBytes(16).toString('hex'), path: disk.mkdtempSync(path.join(userData, 'reporting-native-')) }

  disk.writeFileSync(path.join(created.path, 'owner'), created.id, { flag: 'wx' })
  saveRecord(created)
  validateNativeDirectory({ userData, record: created, disk, platform })
  return created
}

// Legacy body names are the SDK's uuid4() (32 hexadecimal characters), and only an index entry identifies one as ours.
export const cleanDiagnostics = ({ userData, record, native = true, disk = fs, platform = process.platform }) => {
  if (!validateNativeDirectory({ userData, record, disk, platform })) throw new Error('The native diagnostic directory is missing; cleanup was refused')
  const selected = []
  const queue = path.join(userData, 'sentry', 'queue')
  const index = path.join(queue, 'queue-v2.json')

  if (plainPath(disk, index)) {
    const entries = JSON.parse(disk.readFileSync(index, 'utf8'))

    if (!Array.isArray(entries) || entries.some((item) => !item || typeof item.id !== 'string' || !/^[a-f0-9]{32}$/i.test(item.id))) {
      throw new Error('The legacy diagnostic queue index is invalid; cleanup was refused')
    }
    for (const { id } of entries) {
      const body = path.join(queue, id)

      if (plainPath(disk, body)) selected.push(body)
    }
    selected.push(index)
  }

  const scope = path.join(userData, 'sentry', 'scope_v3.json')

  if (plainPath(disk, scope) && native) selected.push(scope)
  for (const name of reportDirectories(platform)) {
    const directory = path.join(record.path, name)

    if (!plainPath(disk, directory, true)) continue
    for (const entry of disk.readdirSync(directory)) {
      if (!entry.endsWith('.dmp')) continue
      const file = path.join(directory, entry)

      if (plainPath(disk, file) && native) selected.push(file)
    }
  }

  // Validate the entire selection before deleting, then recheck each path immediately before unlinking.
  for (const file of new Set(selected)) {
    if (!validateNativeDirectory({ userData, record, disk, platform })) throw new Error('The native diagnostic directory is missing; cleanup was refused')
    if (plainPath(disk, file)) disk.unlinkSync(file)
  }
  return selected
}

// Synchronous persistence is supplied by the existing store host. No renderer preference is an input to the send gate.
export const createReporting = ({ readChoice, writeChoice, cleanup, initialize, abort, changed = () => undefined, available = true }) => {
  let savedChoice = null
  let enabled = false
  let initialized = false
  let restartRequired = false
  let persistenceError = null
  let cleanupError = null
  let error = null
  let revision = 0

  const state = () => ({ available, savedChoice, enabled, initialized, restartRequired, persistenceError, cleanupError, error, revision })
  const publish = () => {
    revision++
    changed(state())
    return state()
  }
  const purge = (native) => {
    try {
      cleanup(native)
      cleanupError = null
      return true
    } catch (failure) {
      cleanupError = 'Old diagnostic data could not be safely removed. Reporting remains off. Check access to the app data folder, then try again.'
      return false
    }
  }
  const saveOff = () => {
    try {
      writeChoice(false)
      savedChoice = false
      persistenceError = null
    } catch (failure) {
      persistenceError = 'Reporting is off for this session, but the choice was not saved. A previously saved opt-in may enable reporting after restart. Try disabling again before restarting.'
    }
  }
  const start = () => {
    try {
      initialize(() => enabled, () => { initialized = true; enabled = true })
    } catch (failure) {
      enabled = false
      if (initialized) {
        restartRequired = true
        try { abort() } catch (abortFailure) { /* Keep the gate closed even if a completed request cannot be aborted. */ }
        saveOff()
        purge(true)
        error = 'Reporting is off because native startup failed. Restart, then enable reporting in Settings.'
      } else {
        error = 'Reporting could not start. Check access to the app data folder, then try again.'
      }
    }
  }
  if (available) {
    try {
      const choice = readChoice()

      if (typeof choice === 'boolean') savedChoice = choice
    } catch (failure) {
      persistenceError = 'The reporting choice could not be read. Reporting is off until a choice can be saved.'
    }
    if (savedChoice === true) start()
    else purge(true)
  }

  const choose = (choice) => {
    error = null
    if (typeof choice !== 'boolean') {
      error = 'A reporting choice must be true or false.'
      return publish()
    }
    if (!available) return state()
    if (!choice) {
      // Revocation must precede every store operation, cleanup, callback and IPC response. close() would flush, so is never used here.
      enabled = false
      restartRequired = initialized
      abort()
      saveOff()
      purge(true)
      return publish()
    }
    if (restartRequired) {
      error = 'Reporting cannot be enabled again in this process. Restart while reporting is off, then enable it in Settings.'
      return publish()
    }
    if (enabled) return state()
    if (!purge(true)) return publish()
    try {
      writeChoice(true)
      savedChoice = true
      persistenceError = null
    } catch (failure) {
      persistenceError = 'The reporting choice was not saved. Reporting remains off.'
      return publish()
    }
    start()
    return publish()
  }

  return { state, choose, canSend: () => enabled }
}

// The SDK's default transport creates a disk queue. This executor has only an in-memory request set and never retries offline data.
export const directTransport = ({ options, createTransport, net, ready, canSend, active }) => {
  const transport = createTransport(options, (request) => ready().then(() => {
    if (!canSend()) return { statusCode: 200 }
    return new Promise((resolve, reject) => {
      if (!canSend()) {
        resolve({ statusCode: 200 })
        return
      }
      const req = net.request({ url: options.url, method: 'POST', partition: 'aurora-reporting', useSessionCookies: false })
      let finished = false
      const finish = (failure, response) => {
        if (finished) return
        finished = true
        active.delete(req)
        if (failure) reject(failure)
        else resolve(response)
      }

      active.add(req)
      req.setHeader('Content-Type', 'application/x-sentry-envelope')
      for (const [key, value] of Object.entries(options.headers || {})) req.setHeader(key, value)
      req.on('response', (response) => {
        response.on('data', () => undefined)
        response.on('error', (failure) => finish(failure))
        response.on('end', () => finish(null, { statusCode: response.statusCode, headers: response.headers }))
      })
      req.on('error', (failure) => finish(failure))
      req.on('abort', () => finish(null, { statusCode: 200 }))
      req.end(request.body)
    })
  }))

  return {
    send: (envelope) => {
      if (!canSend()) return Promise.resolve({})
      const native = envelope[1].some(([header, event]) => header.type === 'event' && event.platform === 'native')
      const items = envelope[1].filter(([header]) => header.type === 'event' || (native && header.type === 'attachment' && header.attachment_type === 'event.minidump')).map(([header, body]) => header.type === 'event' ? [header, minimizeEvent(body)] : [header, body])
      const header = Object.fromEntries(['event_id', 'sent_at', 'dsn'].filter((key) => envelope[0][key] !== undefined).map((key) => [key, envelope[0][key]]))

      if (envelope[0].sdk) header.sdk = { name: envelope[0].sdk.name, version: envelope[0].sdk.version }

      return items.some(([item]) => item.type === 'event') ? transport.send([header, items]) : Promise.resolve({})
    },
    flush: (timeout) => transport.flush(timeout),
  }
}

// The generic preferences IPC cannot address consent, including the companion write of a whole-config swap.
export const reportingStoreRequest = (request, userData) => {
  const refers = (options) => {
    if (!options || (options.cwd && typeof options.cwd !== 'string')) return false
    const cwd = options.cwd ? path.resolve(userData, options.cwd) : userData
    return samePath(path.resolve(cwd, `${options.name || 'config'}.json`), path.resolve(userData, 'reporting.json'))
  }

  return refers(request) || (request && request.op === 'swap' && refers(request.args && request.args[2]))
}

export const installReporting = ({ app, BrowserWindow, ipcMain, net, storeHost }) => {
  const active = new Set()
  const abort = () => {
    const client = Sentry.getClient()

    if (client) client.getOptions().enabled = false
    for (const request of active) {
      try { request.abort() } catch (failure) { /* An already completed request cannot be recalled. */ }
    }
    active.clear()
  }
  const store = () => storeHost.store({ name: 'reporting' })
  const save = (values) => { const target = store(); target.store = { ...target.store, ...values } }
  const owned = () => ensureNativeDirectory({
    userData: app.getPath('userData'),
    record: store().get('nativeDumps'),
    saveRecord: (nativeDumps) => save({ nativeDumps }),
  })
  const reporting = createReporting({
    available: import.meta.env.MODE === 'production',
    readChoice: () => store().get('enabled'),
    writeChoice: (enabled) => save({ enabled }),
    cleanup: (native) => cleanDiagnostics({ userData: app.getPath('userData'), record: owned(), native }),
    abort,
    changed: (state) => BrowserWindow.getAllWindows().forEach((window) => { if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('reporting:changed', state) }),
    initialize: (canSend, nativeStarted) => {
      const record = owned()

      if (!validateNativeDirectory({ userData: app.getPath('userData'), record })) throw new Error('The native diagnostic directory is missing; reporting was refused')
      app.setPath('crashDumps', record.path)
      nativeStarted()
      Sentry.init({
        dsn: DSN,
        release: `aurora-electrons@${version}`,
        transport: (options) => directTransport({ options, createTransport: Sentry.createTransport, net, ready: () => app.whenReady(), canSend, active }),
        defaultIntegrations: false,
        integrations: [Sentry.sentryMinidumpIntegration(), Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration(), Sentry.electronContextIntegration()],
        ipcMode: Sentry.IPCMode.Classic,
        dataCollection: DATA_COLLECTION,
        sendDefaultPii: false,
        sendClientReports: false,
        autoSessionTracking: false,
        enableLogs: false,
        enableMetrics: false,
        enableRendererProfiling: false,
        enableOpenTelemetrySetup: false,
        attachScreenshot: false,
        maxBreadcrumbs: 0,
        tracePropagationTargets: [],
        beforeBreadcrumb: () => null,
        beforeSend: (event, hint) => {
          if (!canSend()) return null
          if (hint && hint.attachments) hint.attachments = event.platform === 'native' ? hint.attachments.filter((attachment) => attachment.attachmentType === 'event.minidump') : []
          return minimizeEvent(event)
        },
      })
    },
  })

  ipcMain.handle(CHANNEL, (_event, request) => {
    if (request && request.op === 'state') return reporting.state()
    if (request && request.op === 'choose') return reporting.choose(request.enabled)
    return { ...reporting.state(), error: 'Unknown reporting request.' }
  })
  return reporting
}
