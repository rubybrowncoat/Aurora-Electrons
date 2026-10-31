/*
  Ownership checks for scripts/lib/owner-temp.js. --no-mutations runs the head only; --vm-only runs just the in-memory boundary probes and never creates or removes a real directory. The native head kills a child uncatchably, then proves reclamation in a fresh process while a live sibling survives.
*/
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { assert, through, subjectModule, runChecks, judged, caughtBy } = require('./lib/fault-credit')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')
const { runSuite } = require('./lib/suite-runner')
const { startChild, lastJson } = require('./lib/check-pool')
const { createOwnedTemp, removeOwnedTemp } = require('./lib/owner-temp')

const FILE = path.join(__dirname, 'lib', 'owner-temp.js')
const SOURCE = fs.readFileSync(FILE, 'utf8')
const PREFIX = 'ae-modules-'
let checks = 0
let failures = 0

const check = (name, ok, detail = '') => {
  checks++
  failures += ok ? 0 : 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// A filesystem held entirely in memory: rmSync records paths, so boundary failures are wrong removed/preserved values without risking real files.
const sandbox = (source = SOURCE) => {
  const nodes = new Map()
  const removed = []
  const probes = []
  const warnings = []
  const renames = []
  let probeHook = () => {}
  let renameHook = () => {}
  const states = new Map()
  let serial = 0
  const add = (file, kind = 'directory', text = '') => {
    nodes.set(file, { kind, text, ino: ++serial, mtimeMs: Date.now(), target: null })
    return file
  }
  const resolve = (file, followLast = true) => {
    const entries = file.split('/').filter(Boolean)
    let current = ''

    for (let index = 0; index < entries.length; index++) {
      current += `/${entries[index]}`
      const item = nodes.get(current)

      if (item && item.kind === 'link' && (followLast || index < entries.length - 1)) {
        return resolve(path.posix.join(item.target, ...entries.slice(index + 1)), followLast)
      }
    }

    return file
  }
  const node = (file, followLast = true) => {
    const resolved = resolve(file, followLast)

    if (!nodes.has(resolved)) {
      throw Object.assign(new Error(`Missing fake path: ${file}`), { code: 'ENOENT' })
    }

    return nodes.get(resolved)
  }
  const stat = (file) => {
    const item = node(file, false)

    return { dev: 1, ino: item.ino, size: item.text.length, mtimeMs: item.mtimeMs, isDirectory: () => item.kind === 'directory', isFile: () => item.kind === 'file', isSymbolicLink: () => item.kind === 'link' }
  }
  const fakeFs = {
    lstatSync: stat,
    statSync: stat,
    realpathSync: (file) => resolve(file),
    readFileSync: (file) => node(file).text,
    writeFileSync: (file, text, { flag } = {}) => {
      if (flag === 'wx' && nodes.has(resolve(file))) {
        throw Object.assign(new Error('fake file exists'), { code: 'EEXIST' })
      }
      return add(resolve(file), 'file', text)
    },
    readdirSync: (directory) => [...nodes.keys()].filter((file) => path.posix.dirname(file) === resolve(directory) && file !== resolve(directory)).map((file) => path.posix.basename(file)),
    mkdtempSync: (prefix) => add(resolve(`${prefix}${String(++serial).padStart(6, '0')}`)),
    renameSync: (from, to) => {
      renameHook(from, to)
      from = resolve(from, false)
      to = resolve(to, false)
      node(from)
      if (nodes.has(to)) {
        if (node(from, false).kind !== 'file' || node(to, false).kind !== 'file') {
          throw Object.assign(new Error('fake destination already exists'), { code: 'EEXIST' })
        }
        nodes.delete(to)
      }
      renames.push([from, to])
      const moving = [...nodes.entries()].filter(([file]) => file === from || file.startsWith(`${from}/`))

      moving.forEach(([file]) => nodes.delete(file))
      moving.forEach(([file, item]) => nodes.set(to + file.slice(from.length), item))
    },
    rmSync: (directory) => {
      directory = resolve(directory)
      removed.push(directory)
      ;[...nodes.keys()].filter((file) => file === directory || file.startsWith(`${directory}/`)).forEach((file) => nodes.delete(file))
    },
  }
  const fakeProcess = {
    pid: 100,
    platform: 'linux',
    stderr: { write: (text) => warnings.push(text) },
    kill: (pid, signal) => {
      probes.push([pid, signal])
      const state = states.get(pid) || 'live'

      probeHook(pid, probes.length)

      if (state !== 'live') {
        throw Object.assign(new Error(state), { code: state })
      }
    },
  }
  add('/managed')
  add('/outside')
  const context = { require: (name) => ({ fs: fakeFs, os: { tmpdir: () => '/managed' }, path: path.posix, crypto: { randomBytes: () => Buffer.alloc(16, 7) } }[name]), module: { exports: {} }, process: fakeProcess, Buffer, Date }

  vm.runInNewContext(source, context, { filename: FILE, timeout: 1000 })

  const owner = (pid, { prefix = PREFIX, nonce = 'a'.repeat(32), marker = true, root = '/managed' } = {}) => {
    const directory = add(`${root}/${prefix}${pid}-${nonce}-${String(++serial).padStart(6, '0')}`)

    if (marker) {
      add(`${directory}/.ae-owner.json`, 'file', JSON.stringify({ version: 1, prefix, pid, nonce }))
    }

    return directory
  }

  const api = subjectModule(context.module.exports, 'owner-temp helper')

  return { api, nodes, removed, probes, states, warnings, renames, add, owner, setProbeHook: (hook) => { probeHook = hook }, setRenameHook: (hook) => { renameHook = hook }, reload: (pid) => { const fresh = { ...context, module: { exports: {} }, process: { ...fakeProcess, pid } }; vm.runInNewContext(source, fresh, { filename: FILE, timeout: 1000 }); return subjectModule(fresh.module.exports) }, create: (prefix = PREFIX, root = '/managed') => through('create an owned temp directory', () => api.createOwnedTemp(prefix, root)) }
}

const pendingClaim = (fixture, { empty = false, mismatch = false, malformed = false, badRecordedMarker = false } = {}) => {
  const container = fixture.owner(210)
  const payload = fixture.owner(211, { root: container })
  const marker = fixture.nodes.get(`${payload}/.ae-owner.json`).text

  fixture.nodes.get(payload).ino = 9007199254740993n
  fixture.add(`${payload}/kept.txt`, 'file', 'bytes to preserve')
  fixture.add(`${container}/.ae-claim.json`, 'file', malformed ? '{' : JSON.stringify({ version: 1, prefix: PREFIX, name: path.posix.basename(payload), expected: { text: badRecordedMarker ? 'not an owner marker' : marker, dev: '1', ino: mismatch ? '9007199254740992' : '9007199254740993' } }))
  if (empty) {
    ;[...fixture.nodes.keys()].filter((file) => file === payload || file.startsWith(`${payload}/`)).forEach((file) => fixture.nodes.delete(file))
  }
  fixture.states.set(210, 'ESRCH')
  return { container, payload }
}
const boundaries = (source = SOURCE) => [
  {
    id: 'dead',
    name: 'a freshly killed owner is reclaimed without an age threshold',
    run: () => {
      const fixture = sandbox(source)
      const dead = fixture.owner(201)

      fixture.add(path.posix.join(dead, 'dead-owned.txt'), 'file', 'dead owner bytes')
      fixture.states.set(201, 'ESRCH')
      fixture.create()
      assert.equal(fixture.nodes.has(dead), false, 'dead owner folder remains')
      assert.equal([...fixture.nodes.keys()].some((file) => file.endsWith('/dead-owned.txt')), false, 'dead owner bytes were only moved into another leaking folder')
    },
  },
  {
    id: 'live',
    name: 'an old live owner and a reused PID both survive',
    run: () => {
      const fixture = sandbox(source)
      const live = fixture.owner(202)
      const reused = fixture.owner(203, { nonce: 'b'.repeat(32) })

      fixture.nodes.get(live).mtimeMs = 0
      fixture.nodes.get(`${reused}/.ae-owner.json`).text = JSON.stringify({ version: 1, prefix: PREFIX, pid: 203, nonce: 'b'.repeat(32), bornAt: 'a different process birth' })
      fixture.create()
      assert.equal(fixture.nodes.has(live), true, 'old live owner folder removed')
      assert.equal(fixture.nodes.has(reused), true, 'reused live PID folder removed')
    },
  },
  {
    id: 'unknown',
    name: 'EPERM and unknown liveness failures preserve owners',
    run: () => {
      for (const code of ['EPERM', 'EACCES', 'UNKNOWN']) {
        const fixture = sandbox(source)
        const directory = fixture.owner(204)

        fixture.states.set(204, code)
        fixture.create()
        assert.equal(fixture.nodes.has(directory), true, `${code} is not proof of death`)
      }
    },
  },
  {
    id: 'legacy',
    name: 'old unmarked and malformed folders remain untouched',
    run: () => {
      const fixture = sandbox(source)
      const legacy = fixture.add('/managed/ae-modules-old123')
      const unmarked = fixture.owner(205, { marker: false })
      const invalid = fixture.owner(206)

      fixture.states.set(205, 'ESRCH')
      fixture.states.set(206, 'ESRCH')
      fixture.nodes.get(`${invalid}/.ae-owner.json`).text = '{}'
      fixture.create()
      assert.deepEqual([legacy, unmarked, invalid].map((directory) => fixture.nodes.has(directory)), [true, true, true])
    },
  },
  {
    id: 'prefix',
    name: 'only the same exact managed prefix is swept',
    run: () => {
      const fixture = sandbox(source)
      const foreign = fixture.owner(207, { prefix: 'ae-legacy-copy-' })

      fixture.states.set(207, 'ESRCH')
      fixture.create()
      assert.equal(fixture.nodes.has(foreign), true)
      fixture.create('ae-legacy-copy-')
      assert.equal(fixture.nodes.has(foreign), false)
    },
  },
  {
    id: 'once',
    name: 'each process sweeps once per parent and prefix',
    run: () => {
      const fixture = sandbox(source)

      fixture.create()
      const later = fixture.owner(208)

      fixture.states.set(208, 'ESRCH')
      fixture.create()
      assert.equal(fixture.nodes.has(later), true)
      const elsewhere = fixture.owner(208, { root: '/outside' })

      fixture.create(PREFIX, '/outside')
      assert.equal(fixture.nodes.has(elsewhere), false)
    },
  },
  {
    id: 'links',
    name: 'root junctions and nested or direct links never permit recursive deletion',
    run: () => {
      for (const location of ['root', 'candidate', 'nested', 'marker']) {
        const fixture = sandbox(source)
        const directory = fixture.owner(209)
        const link = location === 'root' ? '/managed' : location === 'candidate' ? directory : location === 'marker' ? `${directory}/.ae-owner.json` : fixture.add(`${directory}/linked`)

        fixture.states.set(209, 'ESRCH')
        fixture.nodes.get(link).kind = 'link'
        fixture.nodes.get(link).target = '/outside'
        if (location === 'root') {
          assert.throws(() => fixture.api.createOwnedTemp(PREFIX, '/managed'), /plain directory/)
        } else {
          fixture.create()
        }
        assert.equal(fixture.removed.length, 0, `${location} link was followed`)
      }
    },
  },
  {
    id: 'token',
    name: 'own release requires an unchanged issued token and a plain tree',
    run: () => {
      const fixture = sandbox(source)
      const current = fixture.create()
      const foreign = fixture.owner(100)

      assert.equal(through('release a foreign temp path', () => fixture.api.removeOwnedTemp(foreign)), false)
      fixture.nodes.get(`${current}/.ae-owner.json`).text = '{}'
      assert.equal(through('release a replaced owner marker', () => fixture.api.removeOwnedTemp(current)), false)
      assert.equal(fixture.nodes.has(current), true)
      const fresh = fixture.create()

      assert.equal(through('release an issued temp path', () => fixture.api.removeOwnedTemp(fresh)), true)
      assert.equal(fixture.nodes.has(fresh), false)
    },
  },
  {
    id: 'containment',
    name: 'outside paths and traversal prefixes are refused',
    run: () => {
      const fixture = sandbox(source)

      assert.equal(fixture.api.removeOwnedTemp('/outside'), false)
      assert.throws(() => fixture.api.createOwnedTemp('../ae-modules-', '/managed'), /Unmanaged/)
      assert.equal(fixture.removed.length, 0)
    },
  },
  {
    id: 'claim-recovery',
    name: 'valid interrupted claims recover including exact bigint identities and pre-rename emptiness',
    run: () => {
      for (const empty of [false, true]) {
        const fixture = sandbox(source)
        const { container } = pendingClaim(fixture, { empty })

        fixture.create()
        assert.equal(fixture.nodes.has(container), false)
        assert.equal([...fixture.nodes.keys()].some((file) => file.endsWith('/kept.txt')), false)
        assert.equal(fixture.warnings.length, 0)
      }
    },
  },
  {
    id: 'rescue',
    name: 'mismatched or malformed claims preserve bytes and remain permanently rescued',
    run: () => {
      for (const options of [{ mismatch: true }, { malformed: true }, { empty: true, badRecordedMarker: true }]) {
        const fixture = sandbox(source)

        pendingClaim(fixture, options)
        fixture.create()
        const rescue = [...fixture.nodes.keys()].find((file) => file.endsWith('/.ae-rescue'))

        assert.equal(typeof rescue, 'string', 'a failed claim lacks a durable rescue guard')
        assert.equal(fixture.removed.length, 0)
        assert.equal(fixture.warnings.length, 1)
        const kept = [...fixture.nodes.keys()].find((file) => options.empty ? fixture.nodes.get(file).text.includes('not an owner marker') : file.endsWith('/kept.txt'))
        const original = fixture.nodes.get(kept)?.text

        assert.equal(typeof original, 'string')
        fixture.states.set(100, 'ESRCH')
        fixture.reload(101).createOwnedTemp(PREFIX, '/managed')
        assert.equal(fixture.nodes.has(rescue), true, 'a later sweeper changed the rescue location')
        assert.equal(fixture.nodes.get(kept)?.text, original)
      }
      const fixture = sandbox(source)
      const directory = fixture.owner(216)

      fixture.states.set(216, 'ESRCH')
      fixture.setRenameHook((from, to) => {
        if (from === directory) {
          fixture.add(`${path.posix.dirname(to)}/.ae-rescue`, 'file', 'existing rescue bytes')
        }
      })
      fixture.create()
      assert.equal([...fixture.nodes.values()].some((node) => node.text === 'existing rescue bytes'), true, 'the existing rescue sentinel was overwritten')
    },
  },
  {
    id: 'live-transition',
    name: 'a PID becoming live after the first query prevents a claim',
    run: () => {
      const fixture = sandbox(source)
      const directory = fixture.owner(212)

      fixture.states.set(212, 'ESRCH')
      fixture.setProbeHook((_pid, count) => { if (count === 1) { fixture.states.set(_pid, 'live') } })
      fixture.create()
      assert.equal(fixture.nodes.has(directory), true)
      assert.equal(fixture.renames.length, 0)
    },
  },
  {
    id: 'candidate-race',
    name: 'a candidate replaced during the final query is claimed without deleting replacement bytes',
    run: () => {
      const fixture = sandbox(source)
      const directory = fixture.owner(213)

      fixture.states.set(213, 'ESRCH')
      fixture.setProbeHook((_pid, count) => {
        if (count === 2) {
          fixture.add(directory)
          fixture.add(`${directory}/kept.txt`, 'file', 'replacement bytes')
        }
      })
      fixture.create()
      assert.equal(fixture.removed.length, 0)
      assert.equal([...fixture.nodes.values()].some((node) => node.text === 'replacement bytes'), true)
      assert.equal([...fixture.nodes.keys()].some((file) => file.endsWith('/.ae-rescue')), true)
    },
  },
  {
    id: 'ancestor-race',
    name: 'an ancestor becoming a junction during the final query permits no rename or deletion',
    run: () => {
      const fixture = sandbox(source)
      const directory = fixture.owner(214)
      const victim = fixture.add(`/outside/${path.posix.basename(directory)}`)

      fixture.add(`${victim}/kept.txt`, 'file', 'outside bytes')
      fixture.states.set(214, 'ESRCH')
      fixture.setProbeHook((_pid, count) => {
        if (count === 2) {
          fixture.nodes.get('/managed').kind = 'link'
          fixture.nodes.get('/managed').target = '/outside'
        }
      })
      assert.throws(() => fixture.api.createOwnedTemp(PREFIX, '/managed'), /plain directory/)
      assert.equal(fixture.renames.length, 0)
      assert.equal(fixture.removed.length, 0)
      assert.equal(fixture.nodes.get(`${victim}/kept.txt`).text, 'outside bytes')
    },
  },
  {
    id: 'concurrent-claim',
    name: 'a competing cleaner winning rename preserves its payload and releases the empty loser',
    run: () => {
      const fixture = sandbox(source)
      const directory = fixture.owner(215)
      const winner = `/outside/${path.posix.basename(directory)}`

      fixture.add(`${directory}/kept.txt`, 'file', 'winner bytes')
      fixture.states.set(215, 'ESRCH')
      fixture.setRenameHook((from) => {
        if (from === directory) {
          const moved = [...fixture.nodes.entries()].filter(([file]) => file === directory || file.startsWith(`${directory}/`))

          moved.forEach(([file]) => fixture.nodes.delete(file))
          moved.forEach(([file, node]) => fixture.nodes.set(winner + file.slice(directory.length), node))
        }
      })
      fixture.create()
      assert.equal(fixture.nodes.get(`${winner}/kept.txt`)?.text, 'winner bytes')
      assert.equal(fixture.warnings.length, 0)
      assert.equal(fixture.removed.length, 1)
    },
  },
  {
    id: 'rescue-ancestor',
    name: 'a rescue descendant blocks disposal of its owning ancestor',
    run: () => {
      const fixture = sandbox(source)
      const directory = fixture.create()
      const rescue = fixture.add(`${directory}/preserved`)

      fixture.add(`${rescue}/.ae-rescue`, 'file', 'rescue marker bytes')
      fixture.add(`${rescue}/kept.txt`, 'file', 'rescued bytes')
      assert.equal(fixture.api.removeOwnedTemp(directory), false)
      assert.equal(fixture.nodes.get(`${rescue}/kept.txt`)?.text, 'rescued bytes')
    },
  },
]

const faults = [
  {
    key: 'age',
    name: 'age alone decides reclamation',
    fails: ['dead', 'live'],
    edits: [
      ['owner && deadOwner(owner.pid)', 'owner && fs.statSync(directory).mtimeMs < Date.now() - 86400000'],
      ['!sameIdentity(before, expected) || !deadOwner(before.pid)', '!sameIdentity(before, expected)'],
    ],
  },
  {
    key: 'live',
    name: 'a live owner is treated as dead',
    fails: ['live', 'unknown'],
    edits: [
      ["return error.code === 'ESRCH'", 'return true'],
      ['process.kill(pid, 0)\n    return false', 'process.kill(pid, 0)\n    return true'],
    ],
  },
  {
    key: 'legacy-marker',
    name: 'malformed marker accepted as ownership',
    fails: ['legacy'],
    edits: [
      ['owner.version !== 1 || owner.prefix !== prefix || owner.pid !== Number(match[1]) || owner.nonce !== match[2]', 'false'],
      ['pid: owner.pid, nonce: owner.nonce', 'pid: Number(match[1]), nonce: match[2]'],
    ],
  },
  {
    key: 'skip-prefix',
    name: 'same-prefix orphans are skipped',
    fails: ['dead', 'prefix'],
    edits: [
      ['.filter((name) => name.startsWith(prefix))', '.filter(() => false)'],
    ],
  },
  {
    key: 'repeat-sweep',
    name: 'sweep repeats after first creation',
    fails: ['once'],
    edits: [
      ['if (!swept.has(key))', 'if (true)'],
    ],
  },
  {
    key: 'descendant-link',
    name: 'nested links are allowed into recursive removal',
    fails: ['links'],
    edits: [
      ['return !stat.isSymbolicLink() && (stat.isFile() || (stat.isDirectory() && samePath(fs.realpathSync(file), file) && plainTree(file)))', 'return true'],
    ],
  },
  {
    key: 'unissued-token',
    name: 'foreign same-PID path is accepted without an issued token',
    fails: ['token'],
    edits: [
      ['const owner = issued.get(directory)', "const owner = issued.get(directory) || { root: path.dirname(directory), prefix: 'ae-modules-', ...identity(directory, path.dirname(directory), 'ae-modules-') }"],
    ],
  },
  {
    key: 'unsafe-prefix',
    name: 'a traversal prefix bypasses the whitelist',
    fails: ['containment'],
    edits: [
      ['if (!PREFIXES.has(prefix))', 'if (false)'],
    ],
  },
  {
    key: 'pending-recovery',
    name: 'valid interrupted pending claims are never recovered',
    fails: ['claim-recovery'],
    edits: [
      ['owner && deadOwner(owner.pid)', 'owner && !present(path.join(directory, CLAIM)) && deadOwner(owner.pid)'],
    ],
  },
  {
    key: 'rescue-marking',
    name: 'a failed claim keeps reclamation authority instead of a rescue guard',
    fails: ['rescue'],
    edits: [
      ['fs.renameSync(path.join(directory, MARKER), path.join(directory, RESCUE))', 'void directory'],
    ],
  },
  {
    key: 'last-query',
    name: 'the final liveness query is omitted',
    fails: ['live-transition'],
    edits: [
      ['!sameIdentity(before, expected) || !deadOwner(before.pid)', '!sameIdentity(before, expected)'],
    ],
  },
  {
    key: 'candidate-binding',
    name: 'moved inode identity is ignored',
    fails: ['candidate-race'],
    edits: [
      ['left.ino === right.ino', 'true'],
    ],
  },
  {
    key: 'ancestor-binding',
    name: 'quarantine creation trusts a newly linked parent',
    fails: ['ancestor-race'],
    edits: [
      ['const newOwnedDirectory = (prefix, root) => {\n  if (!plainDirectory(root))', 'const newOwnedDirectory = (prefix, root) => {\n  if (false)'],
    ],
  },
  {
    key: 'empty-loser',
    name: 'a losing cleaner rescues an empty container forever',
    fails: ['concurrent-claim'],
    edits: [
      ["error.code === 'ENOENT' && !present(payload)", "false && error.code === 'ENOENT' && !present(payload)"],
    ],
  },
  {
    key: 'rescue-ancestor',
    name: 'a rescue descendant is swallowed by ancestor disposal',
    fails: ['rescue-ancestor'],
    edits: [
      ['names.includes(RESCUE) || !validClaim(directory, names)', 'false || !validClaim(directory, names)'],
    ],
  },
  {
    key: 'bigint-precision',
    name: 'inode JSON silently rounds bigint identity',
    fails: ['claim-recovery'],
    edits: [
      ['ino: String(stat.ino)', 'ino: String(Number(stat.ino))'],
    ],
  },
  {
    key: 'empty-malformed',
    name: 'an empty pending claim accepts malformed recorded ownership',
    fails: ['rescue'],
    edits: [
      ['  const recorded = JSON.parse(expected.text)', '  const recorded = expected.text === \'not an owner marker\' ? { version: 1, prefix: claim.prefix, pid: Number(match[1]), nonce: match[2] } : JSON.parse(expected.text)'],
    ],
  },
  {
    key: 'rescue-overwrite',
    name: 'a preexisting rescue sentinel is overwritten',
    fails: ['rescue'],
    edits: [
      ['if (!present(path.join(directory, RESCUE)))', 'if (true)'],
    ],
  },
  {
    key: 'quarantine-leak',
    name: 'dead bytes are only moved into another leaking folder',
    fails: ['dead'],
    edits: [
      ['|| !removeOwnedTemp(container)', '|| false'],
    ],
  },
]

// Existing shared junctions are metadata only: the subject sees a capability boundary that cannot enumerate, create, write, rename or remove anything. A regression is an attempted-operation value, never authority to write through the shared target.
const containsNativeFile = (directory, wanted) => fs.readdirSync(directory).some((name) => {
  const file = path.join(directory, name)
  const stat = fs.lstatSync(file)

  if (stat.isSymbolicLink()) {
    throw new Error('the native fixture reader refuses links')
  }
  return stat.isDirectory() ? containsNativeFile(file, wanted) : name === wanted
})
const actualJunctionBoundary = () => {
  const root = path.resolve(__dirname, '..', 'node_modules')
  const stat = fs.lstatSync(root)

  if (!stat.isSymbolicLink()) {
    console.log('SKIP  real junction metadata: this checkout has ordinary dependencies')
    return
  }

  const real = fs.realpathSync(root)
  const metadata = new Map()
  let current = path.parse(root).root

  for (const entry of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, entry)
    metadata.set(current, fs.lstatSync(current))
  }

  const attempted = []
  const denied = (operation) => {
    attempted.push(operation)
    throw new Error(`the metadata-only boundary refused ${operation}`)
  }
  const boundaryFs = new Proxy({}, {
    get: (_target, operation) => {
      if (operation === 'lstatSync') {
        return (file) => metadata.has(file) ? metadata.get(file) : denied(`lstat outside observed ancestry: ${file}`)
      }
      if (operation === 'realpathSync') {
        return (file) => file === root ? real : denied(`realpath outside observed root: ${file}`)
      }
      return () => denied(operation)
    },
  })
  const context = { require: (name) => ({ fs: boundaryFs, path, os: { tmpdir: () => root }, crypto: { randomBytes: () => denied('randomBytes') } }[name]), module: { exports: {} }, process: { pid: process.pid, platform: process.platform, kill: () => denied('kill'), stderr: { write: () => denied('stderr') } } }

  vm.runInNewContext(SOURCE, context, { filename: FILE, timeout: 1000 })
  let refusal = ''

  try {
    context.module.exports.createOwnedTemp(PREFIX, root)
  } catch (error) {
    refusal = error.message
  }

  check('actual junction metadata rejects the root before every trapped side effect', refusal.includes('not a plain directory') && attempted.length === 0 && real.toLowerCase() !== root.toLowerCase(), `attempted operations: ${attempted.join(', ') || 'none'}`)
}
// Capability guard for every actual rename/removal in the controller and each fixture child. The helper still owns its semantic checks; this separate boundary limits even a regression to the exact explicitly supplied disposable root.
const guardNativeMutation = (root) => {
  const fs = require('fs')
  const path = require('path')
  const absolute = path.resolve(root)
  const canonical = fs.realpathSync(absolute)
  const same = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right

  if (!same(absolute, canonical)) {
    throw new Error('the native mutation boundary refuses an aliased root')
  }

  const verify = (file) => {
    const resolved = path.resolve(file)
    const relative = path.relative(absolute, resolved)

    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`native mutation outside the exact disposable root: ${resolved}`)
    }

    let current = absolute
    const parents = path.relative(absolute, path.dirname(resolved)).split(path.sep).filter(Boolean)

    for (const entry of ['', ...parents]) {
      current = entry ? path.join(current, entry) : current
      const stat = fs.lstatSync(current)

      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`native mutation through a linked parent: ${current}`)
      }
    }

    const realParent = fs.realpathSync(path.dirname(resolved))
    const inside = path.relative(canonical, realParent)

    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
      throw new Error('native mutation parent resolves outside the disposable root')
    }
  }
  const rename = fs.renameSync
  const remove = fs.rmSync

  fs.renameSync = (from, to) => { verify(from); verify(to); return rename(from, to) }
  fs.rmSync = (file, options) => { verify(file); return remove(file, options) }
  let active = true

  return () => { if (active) { fs.renameSync = rename; fs.rmSync = remove; active = false } }
}
const nativeFixtures = new Map()
const preserveNative = (root, reason) => {
  const fixture = nativeFixtures.get(root)
  const errors = []
  let release = () => {}

  if (fixture) {
    try {
      release = guardNativeMutation(fixture.work)
      const marker = path.join(root, '.ae-owner.json')
      const rescue = path.join(root, '.ae-rescue')
      let guarded = false

      try {
        fs.lstatSync(rescue)
        guarded = true
      } catch (error) {
        if (error.code !== 'ENOENT') { throw error }
      }
      if (!guarded) {
        if (fixture.marker !== null && fs.readFileSync(marker, 'utf8') === fixture.marker) {
          fs.renameSync(marker, rescue)
        } else {
          fs.writeFileSync(rescue, '', { flag: 'wx' })
        }
      }
    } catch (error) {
      errors.push(error)
      try {
        fs.writeFileSync(path.join(root, '.ae-rescue'), '', { flag: 'wx' })
      } catch (fallback) {
        if (fallback.code !== 'EEXIST') { errors.push(fallback) }
      }
    } finally {
      try { release() } catch (error) { errors.push(error) }
      try { fixture.restore() } catch (error) { errors.push(error) }
      nativeFixtures.delete(root)
    }
  }
  console.error(`NATIVE-PRESERVED ${root}: ${reason}${errors.length ? `; preservation errors: ${errors.map((error) => error.message).join('; ')}` : ''}`)
  return errors
}

const NATIVE_PREFIX = '@@owner-temp '
const CHILD = [
  "const fs = require('fs')",
  "const path = require('path')",
  'const mode = process.argv[2]',
  ';(' + guardNativeMutation.toString() + ')(__dirname)',
  "if (mode === 'claim') {",
  '  const rename = fs.renameSync.bind(fs)',
  '  fs.renameSync = (from, to) => {',
  '    for (const file of [from, to]) {',
  '      const relative = path.relative(__dirname, file)',
  "      if (relative.startsWith('..') || path.isAbsolute(relative)) { throw new Error('the pending-claim adapter refused a path outside the fixture') }",
  '    }',
  '    const result = rename(from, to)',
  "    if (path.dirname(from) === __dirname && path.dirname(path.dirname(to)) === __dirname && path.basename(path.dirname(to)).startsWith('ae-modules-' + process.pid + '-')) {",
  "      fs.writeSync(1, '@@owner-temp ' + JSON.stringify({ directory: path.dirname(to), payload: to, pid: process.pid, pending: true }) + '\\n')",
  '      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000)',
  "      throw new Error('the pending claimer was not killed after its reported rename')",
  '    }',
  '    return result',
  '  }',
  '}',
  "const { createOwnedTemp, removeOwnedTemp } = require('./subject.cjs')",
  "const directory = createOwnedTemp('ae-modules-', __dirname)",
  "process.on('exit', () => removeOwnedTemp(directory))",
  "console.log('@@owner-temp ' + JSON.stringify({ directory, pid: process.pid }))",
  "if (mode === 'hold') { setInterval(() => {}, 1000) }",
].join('\n')
// Every native child is bounded, and readiness is a reported pathname, never a fixed delay. This helper is unused by --vm-only.
const holdingChild = (script, mode = 'hold') => {
  let accept
  let failReady
  const ready = new Promise((resolve, reject) => { accept = resolve; failReady = reject })
  const child = startChild(script, [mode], {
    limit: 15000,
    maxBuffer: 16384,
    onLine: (line, stream) => {
      if (stream === 'stdout' && line.startsWith(NATIVE_PREFIX)) {
        try {
          accept(JSON.parse(line.slice(NATIVE_PREFIX.length)))
          clearTimeout(timer)
        } catch (error) {
          failReady(error)
        }
      }
    },
  })

  const timer = setTimeout(() => failReady(new Error('the owner child did not report its folder within 5 s')), 5000)
  child.done.then((result) => { clearTimeout(timer); failReady(new Error(`the owner child ended before readiness (${result.code}): ${result.stderr}`)) }, failReady)
  let running = true
  const done = child.done.finally(() => { running = false })

  return { ...child, done, ready, kill: () => { if (running) { child.kill() } } }
}

const verifyNativeChild = (value, root, expectedPid, existing = true) => {
  if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.pid !== expectedPid || typeof value.directory !== 'string' || value.directory !== path.resolve(value.directory) || path.dirname(value.directory) !== root || !new RegExp(`^${PREFIX}${value.pid}-[a-f0-9]{32}-[A-Za-z0-9]{6}$`).test(path.basename(value.directory)) || (existing && (!fs.lstatSync(value.directory).isDirectory() || fs.lstatSync(value.directory).isSymbolicLink()))) {
    throw new Error('the owner child reported a folder outside its exact disposable root or process identity')
  }
}
const disposeNative = (root) => {
  const fixture = nativeFixtures.get(root)

  if (!fixture) {
    throw new Error('the native fixture was never issued by this controller')
  }
  const release = guardNativeMutation(fixture.work)

  try {
    if (!removeOwnedTemp(root)) {
      const failures = preserveNative(root, 'issued-token disposal refused')

      throw new AggregateError([new Error(`the safe helper refused disposal of its native fixture: ${root}`), ...failures], 'native fixture disposal failed')
    }
    nativeFixtures.delete(root)
  } finally {
    release()
    fixture.restore()
  }
}
const finishNativeChildren = async (children) => {
  const errors = []

  for (const child of children) {
    try { child.kill() } catch (error) { errors.push(error) }
  }
  const joined = await Promise.allSettled(children.map((child) => Promise.resolve().then(() => child.done)))

  joined.filter((result) => result.status === 'rejected').forEach((result) => errors.push(result.reason))
  if (errors.length) {
    throw new AggregateError(errors, 'native child cleanup failed')
  }
}
// The outer fixture is owned by the unmodified helper. Even a faulty subject can reach only direct children of this unique explicitly passed disposable root; parent cleanup waits for all its children to end and uses the safe helper's issued token.
const nativeValues = async (source = SOURCE, interrupt = false) => {
  const work = path.resolve(process.env.OWNER_TEMP_WORK || path.join(__dirname, '..', '.check-runs', 'owner-temp'))

  fs.mkdirSync(work, { recursive: true })
  const restore = guardNativeMutation(work)
  let root = null
  const children = []
  let observation = null
  const errors = []

  try {
    root = createOwnedTemp('ae-legacy-cache-', work)
    nativeFixtures.set(root, { restore, work, marker: null })
    nativeFixtures.get(root).marker = fs.readFileSync(path.join(root, '.ae-owner.json'), 'utf8')
    console.log('NATIVE-FIXTURE ' + root)
    const script = path.join(root, 'child.cjs')

    fs.writeFileSync(path.join(root, 'subject.cjs'), source)
    fs.writeFileSync(script, CHILD)
    const dead = holdingChild(script)

    children.push(dead)
    const killed = await dead.ready

    verifyNativeChild(killed, root, dead.pid)
    const ownedFile = `dead-owned-${killed.pid}.txt`

    fs.writeFileSync(path.join(killed.directory, ownedFile), 'dead owner bytes')
    const live = holdingChild(script)

    children.push(live)
    const sibling = await live.ready

    verifyNativeChild(sibling, root, live.pid)

    fs.utimesSync(sibling.directory, new Date(0), new Date(0))
    console.log('NATIVE-OWNERS ' + JSON.stringify({ killed, sibling }))
    dead.kill()
    const ended = await dead.done

    if (ended.timedOut) {
      throw new Error('the owner reached its watchdog instead of the deliberate uncatchable kill')
    }

    let pending = null

    if (interrupt) {
      const claimer = holdingChild(script, 'claim')

      children.push(claimer)
      pending = await claimer.ready
      verifyNativeChild(pending, root, claimer.pid)
      if (pending.pending !== true || path.dirname(pending.payload) !== pending.directory || path.basename(pending.payload) !== path.basename(killed.directory) || !fs.existsSync(path.join(pending.payload, ownedFile))) {
        throw new Error('the pending event did not identify the forwarded rename of the exact dead payload')
      }
      console.log('NATIVE-PENDING ' + JSON.stringify(pending))
      claimer.kill()
      const interrupted = await claimer.done

      if (interrupted.timedOut) {
        throw new Error('the claimer reached its watchdog instead of the deliberate pending-state kill')
      }
    }
    const reclaimer = startChild(script, ['reclaim'], { limit: 5000, maxBuffer: 16384 })
    let reclaiming = true
    const done = reclaimer.done.finally(() => { reclaiming = false })

    children.push({ ...reclaimer, done, kill: () => { if (reclaiming) { reclaimer.kill() } } })
    const reclaimed = await done

    if (reclaimed.code !== 0 || reclaimed.timedOut) {
      throw new Error(`the reclaimer failed (${reclaimed.code}, timeout ${reclaimed.timedOut}): ${reclaimed.stderr}`)
    }

    const created = lastJson(reclaimed, NATIVE_PREFIX)

    verifyNativeChild(created, root, reclaimer.pid, false)

    if (path.dirname(created.directory) !== root || created.pid === sibling.pid || created.pid === killed.pid || (pending && created.pid === pending.pid)) {
      throw new Error('the reclaimer did not report a new owner in the exact disposable root')
    }

    observation = { deadGone: !fs.existsSync(killed.directory) && !containsNativeFile(root, ownedFile), liveKept: fs.existsSync(sibling.directory), pendingGone: pending ? !fs.existsSync(pending.directory) && !containsNativeFile(root, ownedFile) : null, killedPid: killed.pid, livePid: sibling.pid, root }
  } catch (error) {
    errors.push(error)
  }
  try { await finishNativeChildren(children) } catch (error) { errors.push(error) }

  if (errors.length) {
    if (root) {
      errors.push(...preserveNative(root, errors.map((error) => error.message).join('; ')))
    } else {
      try { restore() } catch (error) { errors.push(error) }
    }
    throw new AggregateError(errors, 'native fixture observation or cleanup failed')
  }
  try {
    restore()
  } catch (error) {
    errors.push(error, ...preserveNative(root, error.message))
    throw new AggregateError(errors, 'native fixture guard restoration failed')
  }
  return observation
}
const nativeChecks = (value, interrupt = false) => [
  { id: 'native-dead', name: 'a new process removes the killed child folder', run: () => assert.equal(value.deadGone, true, 'killed child folder remains') },
  { id: 'native-live', name: 'a live old sibling folder survives reclamation', run: () => assert.equal(value.liveKept, true, 'live sibling folder removed') },
  ...(interrupt ? [{ id: 'native-pending', name: 'a new process reclaims the interrupted pending container and exact payload', run: () => assert.equal(value.pendingGone, true, 'interrupted pending payload remains') }] : []),
]

const reportNative = async (interrupt = false) => {
  const value = await nativeValues(SOURCE, interrupt)
  const results = await runChecks(nativeChecks(value, interrupt))

  if (results.every((result) => result.ok)) {
    disposeNative(value.root)
  } else {
    preserveNative(value.root, 'a native head returned the wrong value')
  }
  results.forEach((result) => check(result.name, result.ok, result.detail))
}

const faultResults = async (fault, native = false, interrupt = false) => {
  const source = fault.edits.reduce((given, [from, to]) => plantedPatch(FILE, given, from, to), SOURCE)
  const value = native ? await nativeValues(source, interrupt) : null
  const results = native ? await runChecks(nativeChecks(value, interrupt)) : await runChecks(boundaries(source))
  const failed = judged(results, fault.name)
  const expected = native ? (interrupt ? ['native-pending'] : fault.key === 'age' ? ['native-dead', 'native-live'] : ['native-live']) : fault.fails
  const caught = expected.every((id) => caughtBy(failed, [id], fault))

  if (native) {
    if (caught) {
      disposeNative(value.root)
    } else {
      preserveNative(value.root, 'a native head returned the wrong value')
    }
  }
  check(`${native ? 'native: ' : ''}${fault.name}, changes named values`, caught, failed.map((result) => `${result.id}: ${result.detail}`).join('; '))
}

// Execute the actual generated child against filesystem capabilities held only in memory, including deliberate regressions of its subject. No OS process or filesystem mutation is possible here.
const childCapabilityProbe = (child, mode, kind) => {
  const calls = []
  const exits = []
  const root = '/private'
  const fakeFs = {
    realpathSync: (file) => kind === 'aliased-root' && file === root ? '/outside' : kind === 'escaped-parent' && file === `${root}/tree` ? '/outside' : file,
    lstatSync: (file) => ({ isDirectory: () => true, isSymbolicLink: () => kind === 'linked-parent' && file === `${root}/tree` }),
    rmSync: (...args) => calls.push(['remove', ...args]),
    renameSync: (...args) => calls.push(['rename', ...args]),
  }
  const mutate = () => {
    if (kind === 'outside-rename') { fakeFs.renameSync(`${root}/tree/file`, '/outside/file') } else if (kind === 'inside-rename') { fakeFs.renameSync(`${root}/tree/file`, `${root}/tree/other`) } else { fakeFs.rmSync(kind === 'outside-rm' || kind === 'outside-exit' ? '/outside/foreign-tree' : kind === 'root-rm' ? root : `${root}/tree/file`, { recursive: true }) }
  }
  const subject = {
    createOwnedTemp: () => { if (kind !== 'outside-exit') { mutate() }; return `${root}/ae-modules-123-${'a'.repeat(32)}-ABC123` },
    removeOwnedTemp: () => { if (kind === 'outside-exit') { mutate() } },
  }
  const context = { require: (name) => ({ fs: fakeFs, path: path.posix, './subject.cjs': subject }[name]), __dirname: root, process: { argv: ['bun', 'child.cjs', mode], pid: 123, platform: 'linux', on: (_signal, callback) => exits.push(callback) }, setInterval: () => 0, console: { log: () => {} } }
  let error = null

  try {
    vm.runInNewContext(child, context, { timeout: 1000 })
    exits.forEach((callback) => callback())
  } catch (failure) {
    error = failure.message
  }
  return { calls, error }
}

const errorMessages = (error) => error ? [error.message, ...(Array.isArray(error.errors) ? error.errors.flatMap(errorMessages) : [])] : []

// Actual nativeValues, finishNativeChildren and preservation code, with only their I/O/process adapters replaced by in-memory records. The child join is completed by kill, so a rejected join cannot become an unhandled promise before cleanup starts.
const controllerProbe = async ({ bodyFailure = false, joinFailure = false, controller = nativeValues.toString(), verifier = verifyNativeChild.toString(), report = null } = {}) => {
  const work = '/private'
  const root = `${work}/ae-legacy-cache-100-${'a'.repeat(32)}-ABC123`
  const directory = (pid, prefix = PREFIX) => `${root}/${prefix}${pid}-${'b'.repeat(32)}-ABC123`
  const marker = JSON.stringify({ version: 1, prefix: 'ae-legacy-cache-', pid: 100, nonce: 'a'.repeat(32) })
  const files = new Map([[`${root}/.ae-owner.json`, marker]])
  const directories = new Set([work, root, directory(201), directory(202)])
  const killed = []
  let starts = 0
  let restores = 0
  let nextOwner = 201
  let finishLive
  const liveDone = new Promise((resolve, reject) => { finishLive = () => joinFailure ? reject(new Error('join failed')) : resolve({ code: null, timedOut: false }) })
  const fakeFs = {
    mkdirSync: () => {},
    writeFileSync: (file, value, { flag } = {}) => { if (flag === 'wx' && files.has(file)) { throw Object.assign(new Error('exists'), { code: 'EEXIST' }) }; files.set(file, value) },
    readFileSync: (file) => { if (!files.has(file)) { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }; return files.get(file) },
    existsSync: (file) => files.has(file) || directories.has(file),
    lstatSync: (file) => { if (!files.has(file) && !directories.has(file)) { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }; return { isDirectory: () => directories.has(file), isSymbolicLink: () => false } },
    utimesSync: () => {},
    renameSync: (from, to) => { if (!files.has(from)) { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }; files.set(to, files.get(from)); files.delete(from) },
  }
  const fixtures = new Map()
  const context = {
    fs: fakeFs,
    path: path.posix,
    process: { env: { OWNER_TEMP_WORK: work } },
    __dirname: '/source/scripts',
    SOURCE,
    CHILD,
    PREFIX,
    NATIVE_PREFIX,
    nativeFixtures: fixtures,
    guardNativeMutation: () => { starts++; let active = true; return () => { if (active) { restores++; active = false } } },
    createOwnedTemp: () => root,
    console: { log: () => {}, error: () => {} },
    holdingChild: () => {
      const pid = nextOwner++

      return { pid, ready: Promise.resolve({ pid, directory: directory(pid) }), done: pid === 201 ? Promise.resolve({ code: null, timedOut: false }) : liveDone, kill: () => { killed.push(pid); if (pid === 202) { finishLive() } } }
    },
    startChild: () => {
      if (bodyFailure) { throw new Error('body failed') }
      directories.delete(directory(201))
      const value = report ? report(root, directory) : { pid: 203, directory: directory(203) }

      return { pid: 203, kill: () => killed.push(203), done: Promise.resolve({ code: 0, timedOut: false, stdout: NATIVE_PREFIX + JSON.stringify(value), stderr: '' }) }
    },
    lastJson,
    containsNativeFile: () => false,
  }
  const compile = (source) => vm.runInNewContext(`(${source})`, context, { timeout: 1000 })

  context.verifyNativeChild = compile(verifier)
  context.preserveNative = compile(preserveNative.toString())
  context.finishNativeChildren = compile(finishNativeChildren.toString())
  let value = null
  let failure = null

  try { value = await compile(controller)() } catch (error) { failure = error }
  return { value, messages: errorMessages(failure), rescued: files.has(`${root}/.ae-rescue`), ordinaryMarker: files.has(`${root}/.ae-owner.json`), starts, restores, fixtureRetained: fixtures.has(root), killed }
}

const fixtureChecks = ({ child = CHILD, controller = nativeValues.toString(), verifier = verifyNativeChild.toString() } = {}) => [
  {
    id: 'child-capability',
    name: 'every actual generated child mode contains recursive mutations before underlying I/O',
    run: () => {
      for (const mode of ['hold', 'reclaim', 'claim']) {
        for (const kind of ['outside-rm', 'outside-rename', 'root-rm', 'linked-parent', 'escaped-parent', 'aliased-root', 'outside-exit', 'inside-rm', 'inside-rename']) {
          const value = childCapabilityProbe(child, mode, kind)
          const inside = kind.startsWith('inside-')

          assert.equal(value.calls.length, inside ? 1 : 0, `${mode}/${kind} reached the wrong underlying I/O count`)
          assert.equal(value.error === null, inside, `${mode}/${kind} has the wrong refusal state`)
        }
      }
    },
  },
  {
    id: 'native-join-rescue',
    name: 'actual native observation joins every child and preserves both body and cleanup failures',
    run: async () => {
      for (const bodyFailure of [false, true]) {
        for (const joinFailure of [false, true]) {
          const value = await controllerProbe({ bodyFailure, joinFailure, controller, verifier })
          const failed = bodyFailure || joinFailure

          assert.equal(value.messages.length > 0, failed)
          assert.equal(value.rescued, failed)
          assert.equal(value.starts, value.restores, 'a controller guard remained installed')
          assert.equal(value.killed.includes(201) && value.killed.includes(202), true, 'not every owned child was stopped')
          assert.equal(value.messages.includes('body failed'), bodyFailure)
          assert.equal(value.messages.includes('join failed'), joinFailure)
          assert.equal(value.fixtureRetained, !failed, 'failed residue still has an ordinary fixture token')
        }
      }
      const joined = []
      const context = { Promise, AggregateError }
      const finish = vm.runInNewContext(`(${finishNativeChildren.toString()})`, context, { timeout: 1000 })
      const children = [1, 2, 3].map((id) => ({ kill: () => { if (id === 1) { throw new Error('kill failed') } }, get done () { joined.push(id); return id === 2 ? Promise.reject(new Error('second join failed')) : Promise.resolve() } }))
      let failure

      try { await finish(children) } catch (error) { failure = error }
      assert.deepEqual(joined, [1, 2, 3], 'one child failure skipped other joins')
      assert.equal(errorMessages(failure).includes('kill failed') && errorMessages(failure).includes('second join failed'), true)
    },
  },
  {
    id: 'reclaimer-identity',
    name: 'actual reclaimer observation accepts only its known PID and exact generated cleaned path',
    run: async () => {
      const reports = [
        ['wrong PID', (_root, directory) => ({ pid: 204, directory: directory(204) })],
        ['null PID', (_root, directory) => ({ pid: null, directory: directory(203) })],
        ['bad basename', (root) => ({ pid: 203, directory: `${root}/not-owned` })],
        ['outside', () => ({ pid: 203, directory: `/outside/ae-modules-203-${'b'.repeat(32)}-ABC123` })],
        ['root itself', (root) => ({ pid: 203, directory: root })],
        ['foreign prefix', (_root, directory) => ({ pid: 203, directory: directory(203, 'ae-legacy-copy-') })],
        ['valid cleaned path', (_root, directory) => ({ pid: 203, directory: directory(203) })],
      ]

      for (const [name, report] of reports) {
        const value = await controllerProbe({ controller, verifier, report })
        const valid = name === 'valid cleaned path'

        assert.equal(value.messages.length === 0, valid, `${name} received the wrong identity verdict`)
        assert.equal(value.rescued, !valid)
        assert.equal(value.starts, value.restores)
        assert.equal(valid ? value.value.deadGone && value.value.liveKept : value.value === null, true)
      }
    },
  },
]

const fixtureFaults = [
  { key: 'child-capability', name: 'generated child omits its mutation boundary', fails: ['child-capability'], subject: () => ({ child: plantedPatch('child.js', CHILD, ';(' + guardNativeMutation.toString() + ')(__dirname)', '') }) },
  { key: 'join-rescue', name: 'native observation ignores a rejected child join', fails: ['native-join-rescue'], subject: () => ({ controller: plantedPatch('controller.js', nativeValues.toString(), 'await finishNativeChildren(children)', 'await finishNativeChildren(children).catch(() => {})') }) },
  { key: 'reclaimer-identity', name: 'completed reclaimer bypasses its identity boundary', fails: ['reclaimer-identity'], subject: () => ({ verifier: plantedPatch('verifier.js', verifyNativeChild.toString(), '  if (!value ||', '  if (!existing) { return }\n  if (!value ||') }) },
]
const fixtureFaultResults = async (fault) => {
  const results = await runChecks(fixtureChecks(fault.subject()))
  const failed = judged(results, fault.name)

  check(fault.name, fault.fails.every((id) => caughtBy(failed, [id], fault)), failed.map((result) => `${result.id}: ${result.detail}`).join('; '))
}

const report = async (source = SOURCE) => {
  const results = await runChecks([...boundaries(source), ...fixtureChecks()])

  results.forEach((result) => check(result.name, result.ok, result.detail))
  return results
}

const run = async () => {
  if (process.argv.includes('--metadata-only')) {
    actualJunctionBoundary()
    console.log(`\n${checks - failures} of ${checks} checks passed`)
    process.exitCode = failures ? 1 : 0
    return
  }
  if (process.argv.includes('--vm-only')) {
    await report()
    await report(patched(FILE, SOURCE, "return error.code === 'ESRCH'", "return (error.code === 'ESRCH')"))
    if (mutating()) {
      for (const fault of faults) { await faultResults(fault) }
      for (const fault of fixtureFaults) { await fixtureFaultResults(fault) }
    }
    console.log(`\n${checks - failures} of ${checks} checks passed`)
    process.exitCode = failures ? 1 : 0
    return
  }

  const variants = [
    { key: 'head:boundaries', name: 'ownership boundary values', head: true, deadline: 120, run: () => report() },
    { key: 'head:junction', name: 'actual junction metadata capability boundary', head: true, deadline: 120, run: () => actualJunctionBoundary() },
    {
      key: 'head:native',
      name: 'killed owner and live sibling',
      head: true,
      deadline: 120,
      run: () => reportNative(),
    },
    {
      key: 'head:native-pending',
      name: 'killed pending claimer and live sibling',
      head: true,
      deadline: 120,
      run: () => reportNative(true),
    },
    ...(!mutating() ? [] : [
      { key: 'rewrite:parentheses', name: 'a parenthesized liveness condition preserves behavior', deadline: 120, run: () => report(patched(FILE, SOURCE, "return error.code === 'ESRCH'", "return (error.code === 'ESRCH')")) },
      ...fixtureFaults.map((fault) => ({ key: `fixture-fault:${fault.key}`, name: fault.name, deadline: 120, run: () => fixtureFaultResults(fault) })),
      ...faults.map((fault) => ({ key: `fault:${fault.key}`, name: fault.name, deadline: 120, run: () => faultResults(fault) })),
      ...faults.filter((fault) => ['age', 'live', 'pending-recovery'].includes(fault.key)).map((fault) => ({ key: `native-fault:${fault.key}`, name: `native: ${fault.name}`, deadline: 120, run: () => faultResults(fault, true, fault.key === 'pending-recovery') })),
    ]),
  ]
  const totals = await runSuite({ script: __filename, variants, counts: () => ({ checks, failures }), deadline: 120 })

  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exitCode = totals.harness.length ? 2 : totals.failures ? 1 : 0
}

run().catch((error) => { console.error(error); process.exitCode = 2 })
