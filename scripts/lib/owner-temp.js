// Cooperating check processes reclaim only marked generated direct children. The user-private temp ancestry is trusted to remain stable against arbitrary external rewriting; portable pathname APIs do not provide adversarial directory-handle deletion. Live/reused PIDs and every liveness error except ESRCH are preserved. Historical unmarked folders require a separate explicit migration.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const PREFIXES = new Set(['ae-modules-', 'ae-glossary-mutant-', 'ae-legacy-copy-', 'ae-legacy-mutant-', 'ae-legacy-cache-'])
const MARKER = '.ae-owner.json'
const CLAIM = '.ae-claim.json'
const RESCUE = '.ae-rescue'
const swept = new Set()
const issued = new Map()

const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
const sameIdentity = (left, right) => Boolean(left && right && left.text === right.text && left.dev === right.dev && left.ino === right.ino)
const nameOwner = (name, prefix) => new RegExp(`^${prefix}([1-9][0-9]*)-([a-f0-9]{32})-([A-Za-z0-9]{6})$`).exec(name)
const present = (file) => {
  try {
    fs.lstatSync(file)
    return true
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }

    return false
  }
}

// Check every ancestor too, so static junctions and symlinks cannot redirect a managed pathname.
const plainDirectory = (directory) => {
  const absolute = path.resolve(directory)
  let current = path.parse(absolute).root

  for (const entry of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, entry)

    const stat = fs.lstatSync(current)

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return false
    }
  }

  return samePath(fs.realpathSync(absolute), absolute)
}

const deadOwner = (pid) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

const identity = (directory, root, prefix) => {
  if (path.dirname(directory) !== root || !PREFIXES.has(prefix)) {
    return null
  }

  const match = nameOwner(path.basename(directory), prefix)

  if (!match || !Number.isSafeInteger(Number(match[1])) || !plainDirectory(root) || !plainDirectory(directory) || present(path.join(directory, RESCUE))) {
    return null
  }

  const marker = path.join(directory, MARKER)
  const markerStat = fs.lstatSync(marker)

  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 1024) {
    return null
  }

  const text = fs.readFileSync(marker, 'utf8')
  const owner = JSON.parse(text)

  if (owner.version !== 1 || owner.prefix !== prefix || owner.pid !== Number(match[1]) || owner.nonce !== match[2]) {
    return null
  }

  const stat = fs.lstatSync(directory, { bigint: true })

  return { text, pid: owner.pid, nonce: owner.nonce, dev: String(stat.dev), ino: String(stat.ino) }
}

// A pending claim is a durable recovery record, written before rename. An interrupted valid claim (including an empty pre-rename container) can be reclaimed later; a mismatch cannot. Exact bigint device/inode strings avoid lossy JSON numbers.
const validClaim = (directory, names) => {
  if (!names.includes(CLAIM)) {
    return true
  }

  const file = path.join(directory, CLAIM)
  const stat = fs.lstatSync(file)

  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
    return false
  }

  const claim = JSON.parse(fs.readFileSync(file, 'utf8'))
  const expected = claim.expected

  if (!names.includes(MARKER) || claim.version !== 1 || !PREFIXES.has(claim.prefix) || typeof claim.name !== 'string' || path.basename(claim.name) !== claim.name || !nameOwner(claim.name, claim.prefix) || !expected || typeof expected.text !== 'string' || expected.text.length > 1024 || !/^[0-9]+$/.test(expected.dev) || !/^[0-9]+$/.test(expected.ino) || typeof expected.dev !== 'string' || typeof expected.ino !== 'string' || names.some((name) => ![MARKER, CLAIM, claim.name].includes(name))) {
    return false
  }

  const match = nameOwner(claim.name, claim.prefix)
  const recorded = JSON.parse(expected.text)

  if (!Number.isSafeInteger(Number(match[1])) || !recorded || recorded.version !== 1 || recorded.prefix !== claim.prefix || recorded.pid !== Number(match[1]) || recorded.nonce !== match[2]) {
    return false
  }

  const payload = path.join(directory, claim.name)

  return !names.includes(claim.name) || sameIdentity(identity(payload, directory, claim.prefix), expected)
}

// A rescue anywhere below a root prevents ancestor disposal too. Never traverse a symlink, junction or special file; normal check trees contain regular files and directories only.
const plainTree = (directory) => {
  const names = fs.readdirSync(directory)

  if (names.includes(RESCUE) || !validClaim(directory, names)) {
    return false
  }

  return names.every((name) => {
    const file = path.join(directory, name)
    const stat = fs.lstatSync(file)

    return !stat.isSymbolicLink() && (stat.isFile() || (stat.isDirectory() && samePath(fs.realpathSync(file), file) && plainTree(file)))
  })
}

// Current-token disposal has no PID callback after validation. A claimed orphan is now inside a private live-owner container that other cooperating sweepers leave alone.
const removeOwnedTemp = (directory) => {
  const owner = issued.get(directory)

  if (!owner || owner.pid !== process.pid) {
    return false
  }

  try {
    const before = identity(directory, owner.root, owner.prefix)

    if (!sameIdentity(before, owner) || !plainTree(directory) || !sameIdentity(identity(directory, owner.root, owner.prefix), before)) {
      return false
    }

    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
    issued.delete(directory)
    return true
  } catch (error) {
    return false
  }
}

const newOwnedDirectory = (prefix, root) => {
  if (!plainDirectory(root)) {
    throw new Error(`The check temp root is not a plain directory: ${root}`)
  }

  const nonce = crypto.randomBytes(16).toString('hex')
  const directory = fs.mkdtempSync(path.join(root, `${prefix}${process.pid}-${nonce}-`))

  fs.writeFileSync(path.join(directory, MARKER), JSON.stringify({ version: 1, prefix, pid: process.pid, nonce }), { flag: 'wx' })
  issued.set(directory, { root, prefix, ...identity(directory, root, prefix) })
  return directory
}

const preserveClaim = (directory, error) => {
  let protection = ''

  try {
    // Renaming an existing ownership marker both removes reclamation authority and persists the rescue guard without allocating a new file. No restoration can overwrite a concurrent claimant's pathname.
    if (!present(path.join(directory, RESCUE))) {
      fs.renameSync(path.join(directory, MARKER), path.join(directory, RESCUE))
    }
  } catch (failure) {
    try {
      fs.writeFileSync(path.join(directory, RESCUE), '', { flag: 'wx' })
    } catch (fallback) {
      protection = `; rescue marking failed: ${failure.message}; ${fallback.message}`
    }
  }

  issued.delete(directory)
  process.stderr.write(`check temp claim preserved at ${directory}: ${error.message}${protection}\n`)
  return false
}

const claimOrphan = (directory, root, prefix, expected) => {
  const before = identity(directory, root, prefix)

  if (!sameIdentity(before, expected) || !deadOwner(before.pid)) {
    return false
  }

  const container = newOwnedDirectory(prefix, root)
  const name = path.basename(directory)
  const payload = path.join(container, name)

  try {
    fs.writeFileSync(path.join(container, CLAIM), JSON.stringify({ version: 1, prefix, name, expected: { text: before.text, dev: before.dev, ino: before.ino } }), { flag: 'wx' })
    fs.renameSync(directory, payload)

    if (!sameIdentity(identity(payload, container, prefix), before) || !plainTree(container) || !removeOwnedTemp(container)) {
      return preserveClaim(container, new Error('the moved identity, claim or link boundary did not validate'))
    }

    return true
  } catch (error) {
    // Another cooperating sweeper may win the rename. An empty valid container holds no foreign payload and can be released normally; every other failure preserves all bytes for inspection.
    if (error.code === 'ENOENT' && !present(payload) && plainTree(container) && removeOwnedTemp(container)) {
      return false
    }

    return preserveClaim(container, error)
  }
}

const createOwnedTemp = (prefix, root = os.tmpdir()) => {
  if (!PREFIXES.has(prefix)) {
    throw new Error(`Unmanaged check temp prefix: ${prefix}`)
  }

  root = path.resolve(root)

  if (!plainDirectory(root)) {
    throw new Error(`The check temp root is not a plain directory: ${root}`)
  }

  const key = `${root}\0${prefix}`

  if (!swept.has(key)) {
    swept.add(key)

    fs.readdirSync(root).filter((name) => name.startsWith(prefix)).forEach((name) => {
      const directory = path.join(root, name)

      try {
        const owner = identity(directory, root, prefix)

        if (owner && deadOwner(owner.pid)) {
          claimOrphan(directory, root, prefix, owner)
        }
      } catch (error) {
        // Unmarked legacy names, malformed markers, links and uncertain I/O are preserved.
      }
    })
  }

  return newOwnedDirectory(prefix, root)
}

module.exports = { createOwnedTemp, removeOwnedTemp }
