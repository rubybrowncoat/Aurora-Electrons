/*
  bun scripts/check-reporting.js [--no-mutations] [mutant:<1..3>]
  Pure production-controller, transport and filesystem boundaries; no Electron, SDK initialization, private save or network.
  Three planted faults cover revocation ordering, restart refusal and escaping legacy queue entries. Temporary trees go through scratch-tree.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const assert = require('./lib/bounded-assert')
const { moduleTree } = require('./lib/module-files')
const { loadUtilities } = require('./lib/utilities')
const { patched } = require('./lib/mutant-source')
const { mutating, refusePlanting } = require('./lib/no-mutations')
const { inParallel } = require('./lib/check-pool')
const { removeTree } = require('./lib/scratch-tree')

const ROOT = path.resolve(__dirname, '..')
const FILE = path.join(ROOT, 'src/main/sentry.js')
const SOURCE = fs.readFileSync(FILE, 'utf8')
const load = (source) => import(moduleTree()(source
  .replace("import * as Sentry from '@sentry/electron/main'", 'export const sdk = {}; const Sentry = sdk')
  .replace('import.meta.env.MODE', "'production'")
  .replace("import { version } from '../../package.json'", "const version = 'check'"), 'reporting'))
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }
const withDisk = async (run) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-reporting-check-'))
  try { await run(base) } finally { removeTree(base) }
}
const authority = (module, choice, overrides = {}) => {
  const facts = { writes: [], starts: 0, aborts: 0, purges: [], broadcasts: [], saved: choice }
  const controller = module.createReporting({
    readChoice: () => facts.saved,
    writeChoice: (value) => { facts.writes.push(value); facts.saved = value },
    cleanup: (native) => facts.purges.push(native),
    initialize: (_canSend, nativeStarted) => { nativeStarted(); facts.starts++ },
    abort: () => { facts.aborts++ },
    changed: (state) => facts.broadcasts.push(state),
    ...overrides,
  })
  return { controller, facts }
}

const installed = (module, userData, initial = {}, { failInit = false, refuseWrite = false, failSetPath = false } = {}) => {
  let saved = structuredClone(initial)
  const facts = { starts: 0, sends: 0, paths: [], pending: [], options: null }
  const target = {
    get: (key) => saved[key],
    get store () { return structuredClone(saved) },
    set store (value) {
      if (refuseWrite) throw new Error('ENOSPC')
      saved = structuredClone(value)
    },
  }
  let crashDumps = path.join(userData, 'Crashpad')
  const app = {
    getPath: (key) => {
      assert.ok(['userData', 'crashDumps'].includes(key))
      return key === 'userData' ? userData : crashDumps
    },
    setPath: (key, value) => {
      assert.equal(key, 'crashDumps')
      assert.ok(fs.statSync(value).isDirectory(), 'setPath ran before namespace creation')
      assert.equal(fs.readFileSync(path.join(value, 'owner'), 'utf8'), target.get('nativeDumps').id)
      if (failSetPath) throw new Error('setPath refused')
      crashDumps = value
      facts.paths.push(value)
    },
    whenReady: () => Promise.resolve(),
  }
  Object.assign(module.sdk, {
    getClient: () => facts.options && { getOptions: () => facts.options },
    sentryMinidumpIntegration: () => ({}),
    onUncaughtExceptionIntegration: () => ({}),
    onUnhandledRejectionIntegration: () => ({}),
    electronContextIntegration: () => ({}),
    IPCMode: { Classic: 'classic' },
    createTransport: (_options, executor) => ({ send: (envelope) => executor({ body: JSON.stringify(envelope) }), flush: () => Promise.resolve(true) }),
    init: (options) => {
      facts.starts++
      facts.options = options
      assert.equal(app.getPath('crashDumps'), target.get('nativeDumps').path, 'SDK captured the default folder')
      if (failInit) {
        facts.transport = options.transport({ url: 'http://127.0.0.1/unused' })
        facts.pending.push(facts.transport.send([{}, [[{ type: 'event' }, { message: 'init pending' }]]]))
        throw new Error('native setup failed after start')
      }
    },
  })
  const controller = module.installReporting({
    app,
    BrowserWindow: { getAllWindows: () => [] },
    ipcMain: { handle: () => {} },
    net: { request: () => { facts.sends++; throw new Error('unexpected send') } },
    storeHost: { store: () => target },
  })
  return { controller, facts, saved: () => target.store }
}

const CASES = [
  ['default off and positive control', async (module) => {
    for (const choice of [undefined, null, 'true', 1, {}, [], false]) {
      const { controller, facts } = authority(module, choice)
      assert.equal(controller.state().enabled, false)
      assert.equal(facts.starts, 0)
      assert.deepEqual(facts.purges, [true])
      assert.equal(controller.state().savedChoice, choice === false ? false : null)
    }
    const { controller, facts } = authority(module, true)
    assert.equal(controller.canSend(), true)
    assert.equal(facts.starts, 1)
    assert.deepEqual(facts.purges, [], 'enabled-to-enabled launch must not purge before native recovery')
    const unavailable = authority(module, true, { available: false })
    assert.equal(unavailable.controller.choose(true).enabled, false)
    assert.equal(unavailable.facts.starts, 0)
  }],
  ['read write and cleanup failures fail closed', async (module) => {
    const unreadable = authority(module, true, { readChoice: () => { throw new Error('EACCES') } })
    assert.equal(unreadable.controller.state().enabled, false)
    assert.ok(unreadable.controller.state().persistenceError)
    const failedEnable = authority(module, false, { writeChoice: () => { throw new Error('ENOSPC') } })
    assert.equal(failedEnable.controller.choose(true).enabled, false)
    assert.equal(failedEnable.facts.starts, 0)
    assert.equal(failedEnable.controller.state().savedChoice, false)
    const failedCleanup = authority(module, false, { cleanup: () => { throw new Error('EACCES') } })
    assert.equal(failedCleanup.controller.state().enabled, false)
    assert.equal(failedCleanup.controller.choose(true).enabled, false)
    assert.equal(failedCleanup.facts.starts, 0)
    assert.ok(failedCleanup.controller.state().cleanupError)
    const failedInit = authority(module, false, { initialize: (_canSend, nativeStarted) => { nativeStarted(); throw new Error('init') } })
    assert.equal(failedInit.controller.choose(true).enabled, false)
    assert.equal(failedInit.controller.state().restartRequired, true)
    assert.equal(failedInit.controller.choose(true).enabled, false)
  }],
  ['disable closes before persistence and restart rejects every enable', async (module) => {
    let refuseWrite = true
    const created = authority(module, true, {
      writeChoice: () => {
        assert.equal(controller.canSend(), false, 'egress was still open inside the disable write')
        if (refuseWrite) throw new Error('read-only storage')
      },
    })
    const controller = created.controller
    const off = controller.choose(false)
    assert.equal(off.enabled, false)
    assert.equal(off.savedChoice, true)
    assert.equal(off.restartRequired, true)
    assert.match(off.persistenceError, /not saved/)
    for (let window = 0; window < 3; window++) {
      assert.equal(controller.choose(true).enabled, false, 'another or stale window bypassed restart')
      assert.equal(controller.state().savedChoice, true)
    }
    refuseWrite = false
    assert.equal(controller.choose(false).savedChoice, false)
    assert.equal(controller.choose(true).enabled, false)
    const restarted = authority(module, false)
    assert.equal(restarted.controller.state().initialized, false)
    assert.equal(restarted.controller.choose(true).enabled, true)
    assert.equal(restarted.facts.starts, 1)
    assert.equal(restarted.facts.broadcasts[0].enabled, true)
    assert.equal(controller.choose('true').enabled, false)
  }],
  ['first choice decline stays usable and later first enable works', async (module) => {
    const { controller, facts } = authority(module)
    assert.equal(controller.choose(false).savedChoice, false)
    assert.equal(controller.state().restartRequired, false)
    assert.equal(controller.choose(true).enabled, true)
    assert.deepEqual(facts.writes, [false, true])
    assert.equal(controller.choose(false).enabled, false)
    assert.equal(controller.choose(true).enabled, false)
    assert.deepEqual(facts.writes, [false, true, false])
    assert.ok(facts.broadcasts.every((state, index) => state.revision === index + 1))
  }],
  ['native ownership allocates only for absent records or valid missing directories', (module) => withDisk(async (base) => {
    const userData = path.join(base, 'user-data')
    fs.mkdirSync(userData)
    const records = []
    const create = (record) => module.ensureNativeDirectory({ userData, record, saveRecord: (next) => records.push(next) })
    const first = create()
    assert.equal(records.length, 1)
    assert.equal(path.dirname(first.path), userData)
    assert.equal(fs.readFileSync(path.join(first.path, 'owner'), 'utf8'), first.id)
    assert.deepEqual(create(first), first)
    assert.equal(records.length, 1, 'a valid namespace was allocated twice')
    const missing = { id: 'a'.repeat(32), path: path.join(userData, 'genuinely-missing') }
    assert.equal(module.validateNativeDirectory({ userData, record: missing }), false)
    const replacement = create(missing)
    assert.notEqual(replacement.path, missing.path)
    assert.equal(records.length, 2)
    const before = fs.readdirSync(userData)
    const outside = path.join(base, 'outside')
    write(path.join(outside, 'reports/unknown.dmp'), 'unowned bytes')
    for (const record of [null, {}, [], { id: 'bad', path: missing.path }, { id: first.id, path: 2 }, { id: first.id, path: 'relative' }, { id: first.id, path: userData }, { id: first.id, path: outside }, { id: first.id, path: path.join(base, 'absent-outside') }, { id: first.id, path: first.path, extra: true }]) {
      assert.throws(() => create(record), /ownership/)
      assert.throws(() => module.cleanDiagnostics({ userData, record }), /ownership/)
      assert.deepEqual(fs.readdirSync(userData), before)
      assert.equal(records.length, 2, 'invalid ownership allocated a fallback')
      assert.equal(fs.readFileSync(path.join(outside, 'reports/unknown.dmp'), 'utf8'), 'unowned bytes')
    }
    const readDenied = Object.create(fs)
    readDenied.lstatSync = (file) => {
      if (file === first.path) throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      return fs.lstatSync(file)
    }
    assert.throws(() => module.ensureNativeDirectory({ userData, record: first, saveRecord: () => { throw new Error('allocated fallback') }, disk: readDenied }), /EACCES/)
  })],
  ['native ownership rejects replaced linked marker and report paths before init or purge', (module) => withDisk(async (base) => {
    const userData = path.join(base, 'user-data')
    fs.mkdirSync(userData)
    const record = module.ensureNativeDirectory({ userData, saveRecord: () => {} })
    const marker = path.join(record.path, 'owner')
    const sentinel = path.join(record.path, 'reports/owned.dmp')
    write(sentinel, 'keep on validation failure')
    const refuse = () => {
      assert.throws(() => module.ensureNativeDirectory({ userData, record, saveRecord: () => { throw new Error('allocated fallback') } }))
      assert.throws(() => module.cleanDiagnostics({ userData, record, platform: 'win32' }))
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep on validation failure')
      const result = installed(module, userData, { enabled: true, nativeDumps: record })
      assert.equal(result.controller.canSend(), false)
      assert.equal(result.facts.starts, 0)
      assert.deepEqual(result.facts.paths, [])
      assert.ok(result.controller.state().error)
      assert.deepEqual(result.saved().nativeDumps, record)
    }
    write(marker, 'wrong marker')
    refuse()
    fs.unlinkSync(marker)
    refuse()
    fs.mkdirSync(marker)
    refuse()
    fs.rmdirSync(marker)
    const external = path.join(base, 'external')
    write(path.join(external, 'owner'), record.id)
    fs.linkSync(path.join(external, 'owner'), marker)
    refuse()
    fs.unlinkSync(marker)
    write(marker, record.id)
    for (const [platform, directory] of [['win32', 'reports'], ['darwin', 'pending'], ['darwin', 'completed'], ['linux', 'completed']]) {
      const report = path.join(record.path, directory)
      const savedReport = `${report}-saved`
      if (fs.existsSync(report)) fs.renameSync(report, savedReport)
      fs.symlinkSync(external, report, process.platform === 'win32' ? 'junction' : 'dir')
      assert.throws(() => module.validateNativeDirectory({ userData, record, platform }), /linked|escapes/)
      assert.throws(() => module.cleanDiagnostics({ userData, record, platform }), /linked|escapes/)
      fs.rmdirSync(report)
      write(report, 'wrong type')
      assert.throws(() => module.validateNativeDirectory({ userData, record, platform }), /type/)
      fs.unlinkSync(report)
      if (fs.existsSync(savedReport)) fs.renameSync(savedReport, report)
    }
    const original = `${record.path}-saved`
    fs.renameSync(record.path, original)
    write(record.path, 'replaced directory')
    assert.throws(() => module.ensureNativeDirectory({ userData, record, saveRecord: () => {} }), /type/)
    fs.unlinkSync(record.path)
    fs.symlinkSync(original, record.path, process.platform === 'win32' ? 'junction' : 'dir')
    refuse()
    fs.rmdirSync(record.path)
    fs.renameSync(original, record.path)
    const linkedAncestor = path.join(userData, 'linked-ancestor')
    fs.symlinkSync(external, linkedAncestor, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => module.ensureNativeDirectory({ userData, record: { id: record.id, path: path.join(linkedAncestor, 'missing') }, saveRecord: () => {} }), /linked|escapes/)
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep on validation failure')
  })],
  ['native install preserves ownership and saved-on dumps until SDK recovery', (module) => withDisk(async (base) => {
    const userData = path.join(base, 'user-data')
    fs.mkdirSync(userData)
    const fresh = installed(module, userData)
    const record = fresh.saved().nativeDumps
    assert.ok(record)
    assert.equal(fresh.facts.starts, 0)
    assert.equal(fresh.controller.choose(false).savedChoice, false)
    assert.deepEqual(fresh.saved().nativeDumps, record)
    const dump = path.join(record.path, 'reports/previous-main.dmp')
    write(dump, 'previous process recovery bytes')
    const enabled = installed(module, userData, { enabled: true, nativeDumps: record })
    assert.equal(enabled.controller.canSend(), true)
    assert.equal(enabled.facts.starts, 1)
    assert.deepEqual(enabled.facts.paths, [record.path])
    assert.equal(fs.readFileSync(dump, 'utf8'), 'previous process recovery bytes', 'saved-on startup purged before SDK recovery')
    const unowned = path.join(userData, 'Crashpad/reports/unknown.dmp')
    write(unowned, 'unknown default folder bytes')
    enabled.controller.choose(false)
    assert.equal(fs.existsSync(dump), false)
    assert.deepEqual(enabled.saved().nativeDumps, record)
    assert.equal(fs.readFileSync(unowned, 'utf8'), 'unknown default folder bytes')
    const failedPath = installed(module, userData, { enabled: true, nativeDumps: record }, { failSetPath: true })
    assert.equal(failedPath.facts.starts, 0)
    assert.equal(failedPath.controller.canSend(), false)
    assert.equal(failedPath.controller.state().restartRequired, false)
  })],
  ['native init failure closes sends persists off and requires restart with unsaved caveat', (module) => withDisk(async (base) => {
    const userData = path.join(base, 'user-data')
    fs.mkdirSync(userData)
    const record = module.ensureNativeDirectory({ userData, saveRecord: () => {} })
    for (const refuseWrite of [false, true]) {
      const dump = path.join(record.path, 'reports/failed-init.dmp')
      write(dump, 'failed init owned dump')
      const result = installed(module, userData, { enabled: true, nativeDumps: record }, { failInit: true, refuseWrite })
      await Promise.all(result.facts.pending)
      await result.facts.transport.send([{}, [[{ type: 'event' }, { message: 'after init failure' }]]])
      assert.equal(result.facts.sends, 0)
      assert.equal(result.facts.options.enabled, false, 'the SDK client was not disabled on failure')
      assert.equal(result.controller.canSend(), false)
      assert.equal(result.controller.state().restartRequired, true)
      assert.equal(result.controller.state().error, 'Reporting is off because native startup failed. Restart, then enable reporting in Settings.')
      assert.equal(result.saved().enabled, refuseWrite)
      assert.deepEqual(result.saved().nativeDumps, record)
      assert.equal(fs.existsSync(dump), false)
      if (refuseWrite) assert.match(result.controller.state().persistenceError, /not saved.*previously saved opt-in may enable reporting after restart/i)
      else assert.equal(result.controller.state().persistenceError, null)
      assert.equal(result.controller.choose(true).enabled, false)
      assert.equal(result.facts.starts, 1, 'failed native startup was retried in the same process')
    }
  })],
  ['cleanup exactness preserves unlisted user data', (module) => withDisk(async (base) => {
    const userData = path.join(base, 'user-data')
    fs.mkdirSync(userData, { recursive: true })
    const record = module.ensureNativeDirectory({ userData, saveRecord: () => {} })
    const id = 'a'.repeat(32)
    const sentinels = ['config.json', 'history/one.json', 'notebooks/one.txt', 'AuroraDB.db', 'sentry/user.txt', 'sentry/queue/not-ours.txt', `sentry/queue/${'b'.repeat(32)}`, 'Crashpad/reports/user.txt', 'Crashpad/reports/unknown.dmp', 'Crashpad/reports/keep.dmp.txt']
    for (const file of sentinels) write(path.join(userData, file), `user sentinel ${file}`)
    write(path.join(userData, 'sentry/queue/queue-v2.json'), JSON.stringify([{ id, date: new Date().toISOString() }]))
    write(path.join(userData, 'sentry/queue', id), 'old envelope')
    write(path.join(userData, 'sentry/scope_v3.json'), 'old scope')
    write(path.join(record.path, 'reports/old.dmp'), 'synthetic dump')
    const refusingDisk = Object.create(fs)
    refusingDisk.unlinkSync = () => { throw new Error('EACCES unlink') }
    assert.throws(() => module.cleanDiagnostics({ userData, record, platform: 'win32', disk: refusingDisk }), /EACCES unlink/)
    assert.ok(fs.existsSync(path.join(userData, 'sentry/queue/queue-v2.json')))
    const selected = module.cleanDiagnostics({ userData, record, platform: 'win32' })
    assert.equal(selected.length, 4)
    assert.ok(selected.every((file) => !fs.existsSync(file)))
    for (const file of sentinels) assert.equal(fs.readFileSync(path.join(userData, file), 'utf8'), `user sentinel ${file}`)
    assert.deepEqual(module.cleanDiagnostics({ userData, record, platform: 'win32' }), [])
    write(path.join(userData, 'sentry/scope_v3.json'), 'normal opted-in recovery scope')
    write(path.join(record.path, 'reports/current.dmp'), 'normal opted-in recovery dump')
    module.cleanDiagnostics({ userData, record, platform: 'win32', native: false })
    assert.ok(fs.existsSync(path.join(record.path, 'reports/current.dmp')))
    assert.ok(fs.existsSync(path.join(userData, 'sentry/scope_v3.json')))
  })],
  ['cleanup refuses escaping malformed linked hardlinked and unreadable paths', (module) => withDisk(async (base) => {
    const userData = path.join(base, 'user-data')
    fs.mkdirSync(userData, { recursive: true })
    const record = module.ensureNativeDirectory({ userData, saveRecord: () => {} })
    const index = path.join(userData, 'sentry/queue/queue-v2.json')
    const sentinel = path.join(userData, 'sentinel.txt')
    write(sentinel, 'keep user content')
    for (const text of ['not JSON', '{}', JSON.stringify([{ id: '../../sentinel.txt' }]), JSON.stringify([{ id: '/absolute' }])]) {
      write(index, text)
      assert.throws(() => module.cleanDiagnostics({ userData, record }))
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep user content')
      assert.equal(fs.readFileSync(index, 'utf8'), text)
    }
    write(index, '[]')
    const unreadable = Object.create(fs)
    unreadable.readFileSync = () => { throw new Error('EACCES') }
    assert.throws(() => module.cleanDiagnostics({ userData, record, disk: unreadable }), /EACCES/)
    const scope = path.join(userData, 'sentry/scope_v3.json')
    fs.linkSync(sentinel, scope)
    assert.throws(() => module.cleanDiagnostics({ userData, record }), /hard links/)
    fs.unlinkSync(scope)
    const external = path.join(base, 'external')
    write(path.join(external, 'old.dmp'), 'outside dump sentinel')
    fs.symlinkSync(external, path.join(record.path, 'reports'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => module.cleanDiagnostics({ userData, record, platform: 'win32' }), /linked|escapes/)
    assert.equal(fs.readFileSync(path.join(external, 'old.dmp'), 'utf8'), 'outside dump sentinel')
    assert.ok(fs.existsSync(index), 'validation must finish before any deletion')
    fs.rmdirSync(path.join(record.path, 'reports'))
    fs.unlinkSync(index)
    fs.rmdirSync(path.dirname(index))
    fs.symlinkSync(external, path.dirname(index), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => module.cleanDiagnostics({ userData, record }), /linked|escapes/)
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep user content')
  })],
  ['transport gates deferred and active requests without a disk queue', async (module) => {
    let gate = true
    let release
    const requests = []
    const active = new Set()
    const ready = () => new Promise((resolve) => { release = resolve })
    const net = {
      request: () => {
        const request = new EventEmitter()
        request.setHeader = () => {}
        request.end = (body) => { request.body = body; requests.push(request) }
        request.abort = () => request.emit('abort')
        return request
      },
    }
    const createTransport = (_options, executor) => ({ send: (envelope) => executor({ body: JSON.stringify(envelope) }), flush: () => Promise.resolve(true) })
    const transport = module.directTransport({ options: { url: 'http://127.0.0.1/unused' }, createTransport, net, ready, canSend: () => gate, active })
    const envelope = [{}, [[{ type: 'event' }, { message: 'control', platform: 'javascript' }]]]
    const deferred = transport.send(envelope)
    gate = false
    release()
    await deferred
    assert.equal(requests.length, 0, 'an enable-era promise sent after revocation')
    gate = true
    const held = transport.send(envelope)
    release()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(requests.length, 1)
    assert.equal(active.size, 1)
    gate = false
    for (const request of active) request.abort()
    await held
    await transport.send(envelope)
    assert.equal(requests.length, 1)
    assert.equal(active.size, 0)
    gate = true
    await transport.send([{}, [[{ type: 'session' }, { user: 'never sent' }]]])
    assert.equal(requests.length, 1)
  }],
  ['minimization removes context locals sql paths and non-native attachments', async (module) => {
    const value = module.minimizeEvent({
      event_id: 'control',
      message: 'failure C:\\Users\\PATH_CANARY\\AuroraDB.db SELECT * FROM SQL_CANARY',
      exception: { values: [{ type: 'Error', value: 'file /home/PATH_CANARY/save.db', stacktrace: { frames: [{ filename: 'C:\\Users\\PATH_CANARY\\main.js', lineno: 3, vars: { secret: 'LOCAL_CANARY' }, pre_context: ['SQL_CANARY'] }] } }] },
      user: { email: 'USER_CANARY' },
      request: { url: 'https://NETWORK_CANARY' },
      breadcrumbs: [{ message: 'SQL_CANARY' }],
      extra: { secret: 'EXTRA_CANARY' },
      contexts: { device: { name: 'DEVICE_CANARY' }, runtime: { name: 'Electron', version: 'control' } },
    })
    assert.ok(!JSON.stringify(value).includes('CANARY'))
    assert.equal(value.exception.values[0].stacktrace.frames[0].filename, 'main.js')
    assert.equal(value.contexts.runtime.name, 'Electron')
    const envelopes = []
    const transport = module.directTransport({ options: {}, canSend: () => true, active: new Set(), net: {}, ready: () => Promise.resolve(), createTransport: () => ({ send: (envelope) => { envelopes.push(envelope); return Promise.resolve({}) }, flush: () => Promise.resolve(true) }) })
    await transport.send([{ trace: { user_segment: 'TRACE_CANARY' } }, [[{ type: 'event' }, { message: 'control', platform: 'javascript' }], [{ type: 'attachment', attachment_type: 'event.attachment' }, 'SCREENSHOT_CANARY']]])
    assert.equal(envelopes[0][1].length, 1)
    assert.ok(!JSON.stringify(envelopes[0]).includes('CANARY'), 'envelope metadata bypassed event minimization')
    await transport.send([{}, [[{ type: 'event' }, { platform: 'native', level: 'fatal' }], [{ type: 'attachment', attachment_type: 'event.minidump' }, 'synthetic dump'], [{ type: 'attachment' }, 'SCREENSHOT_CANARY']]])
    assert.equal(envelopes[1][1].length, 2, 'native minidump positive control was dropped')
    assert.ok(!module.redactText('opening C:\\Users\\Some Name\\PATH_CANARY\\save.db failed').includes('CANARY'))
    assert.ok(!module.redactText('opening "/Users/Some Name/PATH_CANARY.db" failed').includes('CANARY'))
  }],
  ['ordinary preference import export undo and replacement cannot change consent', async (module) => {
    const { createStoreHost } = await import(moduleTree()(fs.readFileSync(path.join(ROOT, 'src/main/store-host.js'), 'utf8'), 'store-host'))
    const stores = new Map()
    const host = createStoreHost(({ name = 'config' }) => {
      const store = { store: {}, get (key) { return this.store[key] } }
      stores.set(name, store)
      return store
    })
    const userData = path.resolve(os.tmpdir(), 'synthetic-user-data')
    const handle = (request) => module.reportingStoreRequest(request, userData) ? { ok: false } : host.handle(request)
    const { controller } = authority(module, undefined, { readChoice: () => host.store({ name: 'reporting' }).get('enabled'), writeChoice: (enabled) => { host.store({ name: 'reporting' }).store = { enabled } } })
    controller.choose(true)
    handle({ op: 'write', args: [{ spyNPR: false, selectedSeparator: 'Tick', reporting: false, enabled: false }] })
    const { preferences } = await loadUtilities(['preferences'])
    const schema = preferences.buildSchema({ declarations: [], appearance: { key: 'appearance', ids: [] }, policy: { key: 'theme', values: [] }, font: { key: 'font', read: () => ({ ok: false }) }, separators: ['Tick', 'Comma'] })
    const identity = { gameId: null, raceId: null, campaignId: null }
    const exported = preferences.buildExport(schema, stores.get('config').store, identity, ['display'])
    assert.ok(!JSON.stringify(exported.bundle).includes('reporting'))
    const entries = [{ category: 'display', scope: 'app', key: 'selectedSeparator', value: 'Comma' }]
    const plan = preferences.planImport({ store: stores.get('config').store, entries, source: identity, target: identity, categories: ['display'] })
    const imported = preferences.commitImport(stores.get('config').store, plan, { target: identity, source: identity })
    handle({ op: 'write', args: [imported.store] })
    handle({ op: 'write', args: [preferences.undoImport(imported.store, imported.backup).store] })
    handle({ op: 'write', args: [{}] })
    assert.equal(controller.canSend(), true)
    assert.deepEqual(stores.get('reporting').store, { enabled: true })
    for (const request of [{ name: 'reporting', op: 'write', args: [{ enabled: false }] }, { cwd: 'child', name: '../reporting', op: 'clear', args: [] }, { op: 'swap', args: ['{}', {}, { name: 'reporting', key: 'enabled', value: false }] }]) {
      assert.equal(handle(request).ok, false)
    }
    assert.deepEqual(stores.get('reporting').store, { enabled: true })
  }],
]

const MUTATIONS = [
  ['disable leaves the gate open during persistence', '      enabled = false\n      restartRequired = initialized', '      enabled = true\n      restartRequired = initialized', ['disable closes']],
  ['a stale window may enable again before restart', '    if (restartRequired) {', '    if (false) {', ['disable closes', 'first choice']],
  ['queue entries may escape their owned directory', '!/^[a-f0-9]{32}$/i.test(item.id)', 'false', ['cleanup refuses']],
]
const failures = async (module, selected = CASES) => {
  const failed = []
  for (const [name, run] of selected) {
    try { await run(module) } catch (error) { failed.push({ name, error: String(error.stack || error) }) }
  }
  return failed
}

const main = async () => {
  const selected = process.argv.slice(2).filter((arg) => /^mutant:\d+$/.test(arg)).map((arg) => Number(arg.split(':')[1]) - 1)
  if (!selected.length) {
    const failed = await failures(await load(SOURCE))
    failed.forEach((failure) => console.error(`${failure.name}: ${failure.error}`))
    assert.equal(failed.length, 0, 'production reporting boundaries failed')
    console.log(`reporting: ${CASES.length} behavioural cases passed`)
  }
  if (!mutating()) {
    if (selected.length) refusePlanting()
    return
  }
  const mutants = selected.length ? selected : MUTATIONS.map((_, index) => index)
  const results = await inParallel(mutants, async (index) => {
    assert.ok(MUTATIONS[index], `unknown mutant ${index + 1}`)
    const [name, from, to, prefixes] = MUTATIONS[index]
    const module = await load(patched(FILE, SOURCE, from, to))
    const failed = await failures(module, CASES.filter(([label]) => prefixes.some((prefix) => label.startsWith(prefix))))
    assert.ok(failed.length, `mutant ${index + 1} survived: ${name}`)
    return `mutant ${index + 1} caught: ${name}`
  })
  for (const result of results) {
    if (result instanceof Error) throw result
    console.log(result)
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
