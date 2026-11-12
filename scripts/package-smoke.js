// Inspects and launches the actual two-stage Windows package; never opens a game save.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { createRequire } = require('module')
const { spawn, spawnSync } = require('child_process')
const VERSION = require('../package.json').version
const assert = require('./lib/bounded-assert')
const { removeTree, isLink } = require('./lib/scratch-tree')
const { checkPackaged } = require('./lib/native-check')

const ROOT = path.resolve(__dirname, '..')
const PRODUCT = 'Aurora Electrons'
const INNER_NAME = `${PRODUCT}.exe`
const WRAPPER_NAME = `aurora-electrons-${VERSION}.exe`
// Builder 26.15.3 writes a four-part inner ProductVersion; NSIS keeps the semantic string.
// builder.config.js fixes the build number at zero for both PE resource writers.
const INNER_PRODUCT_VERSION = `${VERSION}.0`
assert.ok(/^\d+\.\d+\.\d+$/.test(VERSION), 'release package version has exactly three numeric components')
// SignPath's literal version placeholder. Two literals because a plain string containing it trips no-template-curly-in-string and an expression-free template trips quotes.
const VERSION_TOKEN = '$' + '{version}'
const UNPACKED = path.join(ROOT, 'build/win-unpacked')
const INNER = path.join(UNPACKED, INNER_NAME)
const WRAPPER = path.join(ROOT, 'build', WRAPPER_NAME)
const STATE = path.join(ROOT, 'build/signing-state')
const EVIDENCE = path.join(ROOT, 'build/release-evidence')
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const fileHash = (file) => digest(fs.readFileSync(file))
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`) }
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const sourceSha = () => process.env.GITHUB_SHA || run('git', ['rev-parse', 'HEAD']).trim()
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 32 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.error?.message || ''}\n${result.stdout || ''}\n${result.stderr || ''}`)
  return result.stdout.trim()
}
// Node inherits PowerShell 7's module paths; Windows PowerShell children need their own edition's defaults.
const WINDOWS_POWERSHELL_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
const powershell = (args, { reject = false } = {}) => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'verify-signature.ps1'), ...args], { cwd: ROOT, env: WINDOWS_POWERSHELL_ENV, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })
  if (result.error) throw result.error
  if (reject) {
    assert.notEqual(result.status, 0, 'shared verifier rejects negative control')
    return { rejected: true }
  }
  if (result.status !== 0) throw new Error(`Shared signature verifier failed: ${result.stdout}\n${result.stderr}`)
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())
}
const inspect = (file) => powershell(['-Path', file, '-Inspect'])
const identityArgs = (file, subject, product, productVersion, fileVersion) => ['-Path', file, '-ExpectedFileName', path.basename(file), '-ExpectedSubject', subject, '-ExpectedProduct', product, '-ExpectedProductVersion', productVersion, '-ExpectedFileVersion', fileVersion]
const walk = (directory, prefix = '') => {
  assert.equal(fs.lstatSync(directory).isSymbolicLink(), false, 'package/return root is not a reparse point')
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const target = path.join(directory, entry.name)
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false, `No package reparse point: ${relative}`)
    assert.ok(entry.isDirectory() || entry.isFile(), `Only regular files and directories in a package tree: ${relative}`)
    return entry.isDirectory() ? walk(target, relative) : [relative]
  })
}
const treeHashes = (root = UNPACKED) => Object.fromEntries(walk(root).map((relative) => [relative, fileHash(path.join(root, relative))]))
const assertPayload = (baseline, innerHash, root = UNPACKED) => {
  const current = treeHashes(root)
  assert.deepEqual(Object.keys(current).sort(), Object.keys(baseline).sort(), 'same complete upstream/application file set')
  for (const name of Object.keys(baseline)) assert.equal(current[name], name === INNER_NAME ? innerHash : baseline[name], `preserved exact payload: ${name}`)
  return Object.keys(current).length
}
const stage = (name) => {
  assert.ok(['inner', 'portable'].includes(name), 'known signing stage')
  return name === 'inner' ? { target: INNER, name: INNER_NAME, productVersion: INNER_PRODUCT_VERSION } : { target: WRAPPER, name: WRAPPER_NAME, productVersion: VERSION }
}
const snapshot = (name) => {
  const target = stage(name)
  fs.mkdirSync(STATE, { recursive: true })
  const original = path.join(STATE, `${name}.original.exe`)
  assert.equal(fs.existsSync(original), false, 'refusing a stale signing-state directory; use a fresh build workspace')
  fs.copyFileSync(target.target, original)
  const metadata = inspect(target.target)
  assert.equal(metadata.Product, PRODUCT)
  assert.equal(metadata.ProductVersion, target.productVersion)
  assert.equal(metadata.FileVersion, VERSION)
  writeJson(path.join(STATE, `${name}.json`), { sourceSha: sourceSha(), runId: process.env.GITHUB_RUN_ID || null, attempt: process.env.GITHUB_RUN_ATTEMPT || null, version: VERSION, originalHash: fileHash(original), metadata, ...(name === 'inner' ? { payload: treeHashes() } : {}) })
  console.log(`Captured ${name} exact bytes and PE metadata`)
}
const accept = (name, returned) => {
  const target = stage(name)
  const record = readJson(path.join(STATE, `${name}.json`))
  assert.equal(record.sourceSha, sourceSha())
  assert.equal(record.version, VERSION)
  assert.equal(record.runId, process.env.GITHUB_RUN_ID || null)
  assert.equal(record.attempt, process.env.GITHUB_RUN_ATTEMPT || null)
  const original = path.join(STATE, `${name}.original.exe`)
  assert.equal(fileHash(original), record.originalHash)
  assert.equal(fileHash(target.target), record.originalHash, 'target remains the submitted unsigned bytes before reinsertion')
  const files = walk(path.resolve(returned))
  assert.deepEqual(files, [target.name], 'provider returns exactly the one selected target, no dependencies/additional files')
  const signed = path.join(path.resolve(returned), target.name)
  const subject = process.env.SIGNPATH_EXPECTED_SUBJECT
  assert.ok(subject, 'expected future certificate subject is required')
  const verified = powershell([...identityArgs(signed, subject, PRODUCT, target.productVersion, VERSION), '-OriginalPath', original])
  if (name === 'inner') assertPayload(record.payload, record.originalHash)
  fs.copyFileSync(signed, target.target)
  assert.equal(fileHash(target.target), verified.SHA256, 'reinsertion is byte-exact')
  record.accepted = verified
  writeJson(path.join(STATE, `${name}.json`), record)
  if (name === 'inner') assertPayload(record.payload, verified.SHA256)
  console.log(`Verified and reinserted ${name} ${verified.SHA256}`)
}

const signatureControls = (scratch) => {
  const candidates = [process.env.SIGNATURE_CONTROL, process.execPath, path.join(path.dirname(require('electron')), 'electron.exe'), path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')].filter(Boolean)
  let control
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue
    const result = inspect(file)
    if (result.Status === 'Valid' && result.TimestampPresent && result.Subject && result.Product && result.ProductVersion && result.FileVersion) { control = { file, result }; break }
  }
  assert.ok(control, 'a real trusted timestamped upstream/system positive control is required; SIGNATURE_CONTROL can name one')
  const { file, result } = control
  powershell([...identityArgs(file, result.Subject, result.Product, result.ProductVersion, result.FileVersion), '-OriginalPath', file])
  powershell(identityArgs(file, 'CN=Wrong publisher', result.Product, result.ProductVersion, result.FileVersion), { reject: true })
  powershell(identityArgs(file, result.Subject, 'Wrong product', result.ProductVersion, result.FileVersion), { reject: true })
  powershell(identityArgs(file, result.Subject, result.Product, '999.999.999', result.FileVersion), { reject: true })
  powershell(identityArgs(file, result.Subject, result.Product, result.ProductVersion, '999.999.999'), { reject: true })
  const tampered = path.join(scratch, path.basename(file))
  const bytes = fs.readFileSync(file)
  // Alter a code section byte, not the Authenticode-excluded checksum/certificate directory.
  const pe = bytes.readUInt32LE(0x3c)
  const section = pe + 24 + bytes.readUInt16LE(pe + 20)
  const raw = bytes.readUInt32LE(section + 20)
  assert.ok(raw > section && raw < bytes.length)
  bytes[raw] ^= 1
  fs.writeFileSync(tampered, bytes)
  powershell(identityArgs(tampered, result.Subject, result.Product, result.ProductVersion, result.FileVersion), { reject: true })
  powershell([...identityArgs(file, result.Subject, result.Product, result.ProductVersion, result.FileVersion), '-OriginalPath', tampered], { reject: true })
  const unsigned = path.join(scratch, 'unsigned.exe')
  const unsignedBytes = fs.readFileSync(file)
  const optional = pe + 24
  const directory = optional + (unsignedBytes.readUInt16LE(optional) === 0x20b ? 112 : 96) + 32
  const certificateOffset = unsignedBytes.readUInt32LE(directory)
  assert.ok(certificateOffset > 0 && certificateOffset < unsignedBytes.length, 'positive control carries embedded Authenticode data')
  unsignedBytes.fill(0, directory, directory + 8)
  fs.writeFileSync(unsigned, unsignedBytes.subarray(0, certificateOffset))
  powershell(identityArgs(unsigned, result.Subject, result.Product, result.ProductVersion, result.FileVersion), { reject: true })
  powershell([...identityArgs(file, result.Subject, result.Product, result.ProductVersion, result.FileVersion), '-OriginalPath', unsigned])
  const decisions = powershell(['-SelfTest'])
  return { positive: { name: path.basename(file), ...result }, unsignedOriginalToTrustedSigned: { passed: true, originalSHA256: fileHash(unsigned), signedSHA256: result.SHA256 }, existingCertificatePreserved: true, negativeControls: ['unsigned', 'tampered code', 'changed original PE payload', 'wrong subject', 'wrong ProductName', 'wrong ProductVersion', 'wrong FileVersion'], decisions, scope: 'Trusted upstream/system binary only; not an Aurora project signature' }
}

const noticeCoverage = (packages, text) => {
  const runtime = text.split(/^## 7\. Runtime packages inside `app\.asar`\s*$/m)[1]?.split(/^## /m)[0]
  assert.ok(runtime, 'runtime package notice section is present')
  const entries = runtime.split(/\r?\n/).filter((line) => line.startsWith('- **')).join('\n')
  const covered = new Map()
  for (const match of entries.matchAll(/`([^`\r\n]+)` (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=,|$)/gm)) {
    const versions = covered.get(match[1]) ?? new Set()
    versions.add(match[2])
    covered.set(match[1], versions)
  }
  for (const info of packages) assert.ok(covered.get(info.name)?.has(info.version), `required exact runtime notice entry for ${info.name}@${info.version}`)
  return [...new Set(packages.map((info) => `${info.name}@${info.version}`))].sort()
}

const inspectPackage = async () => {
  const builderRequire = createRequire(require.resolve('app-builder-lib'))
  const asar = builderRequire('@electron/asar')
  const resources = path.join(UNPACKED, 'resources')
  const archive = path.join(resources, 'app.asar')
  const files = asar.listPackage(archive).map((file) => file.replace(/^[/\\]/, '').replace(/\\/g, '/'))
  const loose = walk(UNPACKED)
  const forbidden = (file) => /(^|\/)(references|fixtures|saves|tests?|\.git|\.github|\.check-runs)(\/|$)/i.test(file) || /\.(db|sqlite3?|sql|xlsx?|zip)$/i.test(file) || /(^|\/)out\/(smoke|reporting-smoke)(\/|$)/i.test(file)
  assert.equal(loose.some((file) => /(^|\/)elevate\.exe$/i.test(file)), false, 'unnecessary elevation helper is not distributed')
  assert.ok(fs.statSync(path.join(resources, 'LICENSE.nsis.txt')).size > 0, 'NSIS wrapper licence text')
  for (const file of [...files, ...loose]) assert.equal(forbidden(file), false, `excluded private/fixture/test input: ${file}`)
  for (const prefix of ['out/main/', 'out/preload/', 'out/renderer/']) assert.ok(files.some((file) => file.startsWith(prefix)), `production ${prefix}`)
  const roots = new Set(files.map((file) => file.split('/')[0]))
  assert.ok([...roots].every((root) => ['out', 'node_modules', 'package.json'].includes(root)), 'only production application roots in asar')
  checkPackaged(path.join(ROOT, 'build'))
  const native = loose.filter((file) => /\.node$/i.test(file))
  assert.ok(native.some((file) => /app\.asar\.unpacked\/node_modules\/sqlite3\/.*node_sqlite3\.node$/.test(file)), 'sqlite3 loads outside asar')
  assert.ok(native.every((file) => file.startsWith('resources/app.asar.unpacked/node_modules/')), 'all native modules remain outside asar')
  assert.ok(files.some((file) => /node_modules\/sqlite3\/.*node_sqlite3\.node$/.test(file) && asar.statFile(archive, path.normalize(file)).unpacked), 'asar maps SQLite to the unpacked native file')
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) assert.equal(fileHash(path.join(resources, name)), fileHash(path.join(ROOT, name)), `packaged root ${name}`)
  const electronDist = path.dirname(require('electron'))
  for (const [source, destination] of [['LICENSE', 'LICENSE.electron.txt'], ['LICENSES.chromium.html', 'LICENSES.chromium.html']]) {
    assert.equal(fileHash(path.join(UNPACKED, destination)), fileHash(path.join(electronDist, source)), `upstream ${destination}`)
  }
  const upstream = loose.filter((name) => name !== INNER_NAME && fs.existsSync(path.join(electronDist, name)) && fs.statSync(path.join(electronDist, name)).isFile()).map((name) => {
    assert.equal(fileHash(path.join(UNPACKED, name)), fileHash(path.join(electronDist, name)), `unchanged upstream Electron bytes/signatures: ${name}`)
    return { name, sha256: fileHash(path.join(UNPACKED, name)), ...(/\.(exe|dll)$/i.test(name) ? { signature: inspect(path.join(UNPACKED, name)) } : {}) }
  })
  for (const name of native) assert.equal(fileHash(path.join(UNPACKED, name)), fileHash(path.join(ROOT, name.replace(/^resources\/app\.asar\.unpacked\//, ''))), `unchanged upstream native bytes: ${name}`)
  const packages = []
  for (const file of files.filter((file) => /(^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(file))) {
    const info = JSON.parse(asar.extractFile(archive, path.normalize(file)).toString('utf8'))
    const directory = file.slice(0, -'package.json'.length)
    const licenses = files.filter((entry) => entry.startsWith(directory) && !entry.slice(directory.length).includes('/') && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(entry.slice(directory.length)))
    assert.ok(licenses.length, `required upstream licence text for ${info.name}@${info.version}`)
    licenses.forEach((entry) => assert.ok(asar.extractFile(archive, path.normalize(entry)).length > 0, `nonempty ${entry}`))
    packages.push({ name: info.name, version: info.version, license: info.license, texts: licenses })
  }
  assert.ok(packages.some((item) => item.name === 'sqlite3') && packages.some((item) => item.name === 'sequelize'), 'native/runtime licence inventory')
  const noticeText = fs.readFileSync(path.join(resources, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  const coveredPackages = noticeCoverage(packages, noticeText)
  const omittedNotice = noticeText.replace(/`sqlite3` \d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g, '')
  assert.throws(() => noticeCoverage(packages, omittedNotice), /notice entry for sqlite3/, 'omitting a shipped runtime package fails notice coverage')
  const sqlite3 = packages.find((item) => item.name === 'sqlite3')
  assert.ok(sqlite3?.version && sqlite3.version !== '999.999.999', 'sqlite3 metadata supplies the version control')
  const sqlite3Version = sqlite3.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const wrongVersionNotice = noticeText.replace(/`sqlite3` (\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=,|\r|\n|$)/g, (entry, version) => version === sqlite3.version ? '`sqlite3` 999.999.999' : entry)
  const wrongVersionEntries = wrongVersionNotice.split(/^## 7\. Runtime packages inside `app\.asar`\s*$/m)[1]?.split(/^## /m)[0]?.split(/\r?\n/).filter((line) => line.startsWith('- **')).join('\n') ?? ''
  assert.ok(wrongVersionEntries.includes('`sqlite3` 999.999.999') && !new RegExp(`\`sqlite3\` ${sqlite3Version}(?=,|$)`, 'm').test(wrongVersionEntries), 'wrong-version control keeps the name and replaces the packaged version')
  assert.throws(() => noticeCoverage(packages, wrongVersionNotice), new RegExp(`notice entry for sqlite3@${sqlite3Version}`), 'wrong runtime package version fails notice coverage')
  assert.ok(fs.readFileSync(path.join(resources, 'LICENSE.nsis.txt'), 'utf8').includes('bzip2'), 'complete NSIS toolset notice')
  return { asar: { sha256: fileHash(archive), entries: files.length }, upstream, native: native.map((name) => ({ name, sha256: fileHash(path.join(UNPACKED, name)) })), notices: { root: ['LICENSE', 'THIRD_PARTY_NOTICES.md'], upstream: ['LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources/LICENSE.nsis.txt'], packages, coveredPackages, omittedPackageControl: 'sqlite3', wrongVersionControl: 'sqlite3@999.999.999' } }
}

const launchEnvironment = (work) => {
  const env = { ...process.env }
  for (const key of ['AURORA_DB', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_APP_FILENAME']) delete env[key]
  for (const [key, folder] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'], ['USERPROFILE', 'home'], ['HOME', 'home']]) {
    env[key] = path.join(work, folder)
    fs.mkdirSync(env[key], { recursive: true })
  }
  return env
}
const awaitPrompt = (page) => page.locator('[data-reporting-prompt]').waitFor({ state: 'visible', timeout: 90000 })
const consent = async (page, name) => {
  await awaitPrompt(page)
  await page.screenshot({ path: path.join(EVIDENCE, `${name}-first-choice.png`) })
  await page.locator('[data-reporting-decline]').click()
  await page.locator('[data-reporting-prompt]').waitFor({ state: 'hidden', timeout: 30000 })
  const state = await page.evaluate(() => window.__aurora.reporting.state())
  assert.equal(state.savedChoice, false)
  assert.equal(state.enabled, false)
  assert.equal(state.initialized, false)
  return state
}
const sqlite = async (page, name, database) => {
  const query = await page.evaluate(async (file) => {
    const { Sequelize } = window.__aurora.sequelize
    const db = new Sequelize({ dialect: 'sqlite', storage: file, logging: false })
    try {
      await db.query('CREATE TABLE package_probe (value INTEGER NOT NULL)')
      await db.query('INSERT INTO package_probe (value) VALUES (19), (23)')
      const [rows] = await db.query('SELECT SUM(value) AS answer, sqlite_version() AS version FROM package_probe')
      return rows[0]
    } finally { await db.close() }
  }, database)
  assert.equal(query.answer, 42, 'real packaged sqlite3 query succeeds')
  assert.match(query.version, /^\d+\.\d+\.\d+/)
  assert.ok(fs.statSync(database).size > 0)
  await page.screenshot({ path: path.join(EVIDENCE, `${name}-declined-usable.png`) })
  return query
}

const launchInner = async (scratch) => {
  const { _electron } = require('playwright')
  const work = path.join(scratch, 'inner')
  fs.mkdirSync(work)
  const userData = path.join(work, 'user-data')
  const database = path.join(work, 'synthetic.db')
  const app = await _electron.launch({ executablePath: INNER, args: [`--user-data-dir=${userData}`], cwd: work, env: launchEnvironment(work), timeout: 90000 })
  let result
  let failure = null
  try {
    const actual = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), packaged: app.isPackaged, appPath: app.getAppPath() }))
    assert.equal(path.resolve(actual.userData).toLowerCase(), path.resolve(userData).toLowerCase(), 'disposable userData, never owner settings')
    assert.equal(actual.packaged, true)
    const page = await app.firstWindow({ timeout: 90000 })
    const state = await consent(page, 'inner')
    const query = await sqlite(page, 'inner', database)
    result = { packaged: true, disposableUserData: true, promptObserved: true, declined: true, reporting: state, sqlite: query, syntheticOnly: true }
  } catch (error) {
    failure = { error }
  }
  try { await app.close() } catch (error) {
    if (!failure && app.process().exitCode === null) failure = { error }
  }
  if (failure) throw failure.error
  return result
}

// The NSIS stub starts the application with handle inheritance off, so Playwright cannot own the portable wrapper's pipes. The wrapper is started directly and found through Chromium's own DevToolsActivePort file in the fresh user-data folder. Each stage names itself in its failure and the original error stays as the cause.
const staged = async (label, action) => {
  try { return await action() } catch (error) { throw error.stage ? error : Object.assign(new Error(`portable ${label}: ${error.message}`, { cause: error }), { stage: label }) }
}
const TIMED_OUT = Symbol('timed out')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const within = async (promise, ms, message) => {
  let timer
  try {
    const outcome = await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms, TIMED_OUT) })])
    assert.notEqual(outcome, TIMED_OUT, message)
    return outcome
  } finally { clearTimeout(timer) }
}
const killTree = (pid) => {
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`taskkill /PID ${pid} /T /F failed (${result.status}): ${result.error?.message || ''}`, { cause: result.error })
}
const summary = ({ pid, created, executable }) => ({ pid, created, executable })
// Rows of Win32_Process for a WQL filter. CreationDate comes back as a fixed-width UTC string, so creation times order as strings.
const processes = (filter) => {
  const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; name = $_.Name; executable = $_.ExecutablePath; commandLine = $_.CommandLine; created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') }) } } | ConvertTo-Json -Compress`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: ROOT, env: WINDOWS_POWERSHELL_ENV, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`Windows process query failed (${result.status}): ${result.error?.message || ''}\n${result.stdout}\n${result.stderr}`)
  const text = result.stdout.replace(/^\uFEFF/, '').trim()
  return text ? [].concat(JSON.parse(text)) : []
}
// A process keeps the PID of a parent that ended and Windows reuses PIDs, so a child counts only when it began no earlier than the wrapper it names.
const observe = (pid) => {
  const rows = processes(`ProcessId = ${pid} OR ParentProcessId = ${pid}`)
  const wrapper = rows.find((row) => row.pid === pid)
  return { wrapper, children: rows.filter((row) => row.parent === pid && row.pid !== pid && wrapper?.created && row.created >= wrapper.created) }
}
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// The wrapper runs the application from an unquoted path that may contain spaces and forwards the raw tail of its own command line, so the line cannot be split into arguments: each known argument must appear whole on a token boundary, plain or quoted. Quoted forms cover paths with spaces; a plain form is only accepted when the argument has none.
const hasArgument = (commandLine, argument) => {
  const [, option, value] = /^(--[^=]+=)(.*)$/.exec(argument)
  const forms = [`"${argument}"`, `${option}"${value}"`]
  if (!/\s/.test(argument)) forms.push(argument)
  return forms.some((form) => new RegExp(`(?<!\\S)${escapeRegExp(form)}(?!\\S)`).test(commandLine))
}
const identify = (pid, userData) => {
  const { wrapper, children } = observe(pid)
  assert.ok(wrapper?.created && wrapper.executable && fs.realpathSync.native(wrapper.executable).toLowerCase() === fs.realpathSync.native(WRAPPER).toLowerCase(), 'the live wrapper process is the verified wrapper file and has a readable CreationDate')
  assert.equal(children.length, 1, `exactly one direct child of the live wrapper, found ${JSON.stringify(children.map(summary))}`)
  const [application] = children
  assert.ok(application.executable && application.created && application.commandLine, 'the direct child has a readable ExecutablePath, CreationDate and command line')
  assert.equal(path.win32.basename(application.executable).toLowerCase(), INNER_NAME.toLowerCase(), 'the direct child runs the application executable')
  for (const argument of [`--user-data-dir=${userData}`, '--remote-debugging-port=0']) assert.ok(hasArgument(application.commandLine, argument), `the direct child carries the exact argument ${argument}; its command line is ${application.commandLine}`)
  return { wrapper, application }
}
const ENDPOINT = /^([1-9]\d{0,4})\r?\n(\/devtools\/browser\/[\w-]+)\r?\n?$/
// Chromium publishes its port and browser path in the user-data folder it was given. Content cut off by an unfinished write is polled; the same unusable content twice, a link or a file that is not the folder's own regular file is a failure.
const awaitEndpoint = async (userData, owned, deadline) => {
  const file = path.join(userData, 'DevToolsActivePort')
  const contained = path.join(fs.realpathSync.native(userData), 'DevToolsActivePort').toLowerCase()
  let rejected = null
  while (Date.now() < deadline) {
    assert.equal(owned.ended, null, 'the wrapper ended before DevToolsActivePort was published')
    let stat = null
    try { stat = fs.lstatSync(file) } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (stat) {
      assert.ok(stat.isFile() && stat.nlink === 1, 'DevToolsActivePort is a regular file with a single link')
      assert.equal(fs.realpathSync.native(file).toLowerCase(), contained, 'DevToolsActivePort lies inside the owned user-data folder')
      const text = fs.readFileSync(file, 'utf8')
      const match = ENDPOINT.exec(text)
      if (match && Number(match[1]) <= 65535) return `ws://127.0.0.1:${match[1]}${match[2]}`
      if (text.split(/\r?\n/)[1]) {
        assert.notEqual(text, rejected, 'DevToolsActivePort holds a decimal loopback port and a /devtools/browser/ path')
        rejected = text
      }
    }
    await sleep(250)
  }
  throw new Error('DevToolsActivePort did not appear within 90 s of starting the wrapper')
}
// The application root is wherever the live executable really is, never a guessed NSIS folder name: a real directory strictly inside the private TEMP/TMP, with plain directories and no reparse point on the way, and not the unpacked tree.
const liveRoot = (reported, temp) => {
  const executable = fs.realpathSync.native(reported)
  const root = path.dirname(executable)
  const tempRoot = fs.realpathSync.native(temp)
  assert.equal(path.basename(executable), INNER_NAME, 'the live executable has the application name')
  const inside = path.relative(tempRoot, root)
  assert.ok(inside && inside.split(path.sep)[0] !== '..' && !path.isAbsolute(inside), `the application root is strictly inside the private TEMP/TMP: ${root}`)
  assert.ok(fs.lstatSync(executable).isFile() && !isLink(executable), 'the live executable is a regular file, not a link')
  assert.equal(isLink(tempRoot), false, 'the private TEMP/TMP is not a reparse point')
  for (let directory = root; directory.toLowerCase() !== tempRoot.toLowerCase(); directory = path.dirname(directory)) assert.ok(directory.length > tempRoot.length && fs.lstatSync(directory).isDirectory() && !isLink(directory), `plain directories and no reparse point between the application root and TEMP/TMP: ${directory}`)
  assert.notEqual(root.toLowerCase(), fs.realpathSync.native(UNPACKED).toLowerCase(), 'the live root is not the unpacked tree')
  return { executable, root }
}
const EXPECTED_CLOSE = /Execution context was destroyed|Target closed|has been closed|Session closed/i
// A rejection of the closing call is the page going away; it is accepted only after the owned wrapper exited by itself with code 0.
const closeApplication = async (page, owned) => {
  const started = Date.now()
  const closing = page.evaluate(() => window.close()).then(() => null, (error) => error)
  const [exit, rejection] = await within(Promise.all([owned.exited, closing]), 30000, 'the owned wrapper did not exit by itself within 30 s of the renderer window.close()')
  assert.ok(exit.code === 0 && exit.signal === null, `the owned wrapper exits by itself with code 0, got ${JSON.stringify({ code: exit.code, signal: exit.signal })} ${exit.error?.message || ''}`)
  if (rejection && !EXPECTED_CLOSE.test(rejection.message)) throw rejection
  return { renderer: 'window.close', exitedBySelf: true, exitCode: 0, elapsedMs: Date.now() - started, closeRejection: rejection ? 'page or context closed' : null }
}
// Ends only what this run started: the wrapper PID is ours while Node still holds its live handle, the application PID only while its CreationDate is the one recorded when it was identified. Even a successful scoped kill and wrapper exit cannot prove settlement of an unidentified application. Returns whether anything had to be forced.
const settle = async (owned, application) => {
  let forced = false
  if (owned.child.pid && owned.ended === null) {
    forced = true
    killTree(owned.child.pid)
    await within(owned.exited, 15000, 'the owned wrapper did not end after its process tree was terminated')
  }
  if (owned.child.pid && !application) throw new Error('the application was not identified; wrapper exit does not prove its launched processes are settled')
  if (application) {
    const survivor = () => processes(`ProcessId = ${application.pid}`).find((row) => row.created === application.created)
    if (survivor()) {
      forced = true
      killTree(application.pid)
      for (let attempt = 0; attempt < 20 && survivor(); attempt++) await sleep(250)
      assert.equal(survivor(), undefined, 'the owned application process did not end')
    }
  }
  return forced
}

// connectOverCDP with noDefaults skips Emulation.setFocusEmulationEnabled, a default the shared inner launch gets from Playwright's Electron route; noDefaults stays because the other default it skips is a download override that must not run. The portable page gets only the focus default back, once the genuine prompt is visible and before the ordinary consent click. The observations around it are retained verifier evidence and gate nothing. The page cuts a stalled frame wait after 1 s; a stalled renderer cannot answer its own timer, so the Node side gives up after 2 s and records a deadline with no state or frame fields, because none came back. The page keeps no hook: at most one timer and two frame requests run, each cancels the other when done, and page teardown discards anything left over.
const RENDER_DEADLINE_MS = 2000
const FOCUS_COMMAND = 'Emulation.setFocusEmulationEnabled'
const renderState = () => new Promise((resolve) => {
  const { visibilityState, hidden } = window.document
  const hasFocus = window.document.hasFocus()
  let frames = 0
  let frame = 0
  let timer = 0
  const finish = () => {
    window.clearTimeout(timer)
    window.cancelAnimationFrame(frame)
    resolve({ visibilityState, hidden, hasFocus, frames })
  }
  timer = window.setTimeout(finish, 1000)
  frame = window.requestAnimationFrame(() => {
    frames = 1
    frame = window.requestAnimationFrame(() => {
      frames = 2
      finish()
    })
  })
})
// Only this observation's own deadline becomes a status; a protocol or evaluation error stays an error.
const observeRender = async (page) => {
  const deadline = new Error(`render observation did not return within ${RENDER_DEADLINE_MS} ms`)
  try {
    const state = await within(page.evaluate(renderState), RENDER_DEADLINE_MS, deadline)
    return { status: 'returned', ...state }
  } catch (error) {
    if (error !== deadline) throw error
    return { status: 'deadline', deadlineMs: RENDER_DEADLINE_MS }
  }
}
// The session is returned so the caller holds it open and never detaches it: the emulation is expected to end with the session that enabled it, and it has to outlive the consent click, SQLite and shutdown. browser.close() in finalization disconnects it. One structured line keeps what was observed, even when a later step failed.
const restoreFocus = async (page) => {
  await awaitPrompt(page)
  const observations = { before: null, focus: null, after: null }
  try {
    observations.before = await observeRender(page)
    const session = await page.context().newCDPSession(page)
    observations.focus = { command: FOCUS_COMMAND, enabled: true, accepted: false }
    await session.send(FOCUS_COMMAND, { enabled: true })
    observations.focus.accepted = true
    observations.after = await observeRender(page)
    return { session, observations }
  } catch (error) {
    observations.failure = error.message
    throw error
  } finally {
    console.log(JSON.stringify({ proof: 'portable render observations', ...observations }))
  }
}

const launchPortable = async (scratch, authority) => {
  const { chromium } = require('playwright')
  const work = path.join(scratch, 'portable')
  const userData = path.join(work, 'user-data')
  const temp = path.join(work, 'temp')
  const database = path.join(work, 'synthetic.db')
  let owned = null
  let application = null
  let browser = null
  let result
  let failure = null
  try {
    const env = await staged('prepare', async () => {
      for (const directory of [work, userData, temp]) {
        fs.mkdirSync(directory)
        assert.equal(isLink(directory), false, `owned launch folder is not a reparse point: ${directory}`)
      }
      const environment = launchEnvironment(work)
      delete environment.NODE_OPTIONS
      environment.TEMP = temp
      environment.TMP = temp
      return environment
    })
    const started = Date.now()
    owned = await staged('spawn', async () => {
      const child = spawn(WRAPPER, [`--user-data-dir=${userData}`, '--remote-debugging-port=0'], { cwd: work, env, shell: false, stdio: 'ignore' })
      const handle = { child, ended: null }
      handle.exited = new Promise((resolve) => {
        const finish = (outcome) => { handle.ended = outcome; resolve(outcome) }
        child.once('exit', (code, signal) => finish({ code, signal }))
        child.once('error', (error) => finish({ code: null, signal: null, error }))
      })
      return handle
    })
    const endpoint = await staged('endpoint', () => awaitEndpoint(userData, owned, started + 90000))
    const observed = await staged('identity', async () => identify(owned.child.pid, userData))
    application = observed.application
    const live = await staged('live payload', async () => {
      const found = liveRoot(application.executable, temp)
      const files = assertPayload(authority.payload, authority.innerHash, found.root)
      return { ...found, files }
    })
    await staged('identity recheck', async () => {
      const again = observe(owned.child.pid)
      assert.equal(again.wrapper?.created, observed.wrapper.created, 'the same wrapper process is still alive')
      assert.deepEqual(again.children.map(summary), [summary(application)], 'the same single application process with the same CreationDate and executable path')
    })
    console.log(JSON.stringify({ proof: 'live extracted-tree comparison', root: live.root, files: live.files, exact: true, wrapperPid: owned.child.pid, pid: application.pid, created: application.created, executable: live.executable }))
    browser = await staged('attach', () => chromium.connectOverCDP(endpoint, { noDefaults: true, isLocal: true, timeout: 90000 }))
    const page = await staged('page', async () => {
      const context = browser.contexts()[0]
      assert.ok(context, 'the default browser context is attached')
      return context.pages()[0] ?? await context.waitForEvent('page', { timeout: 90000 })
    })
    const render = await staged('render', () => restoreFocus(page))
    const state = await staged('consent', () => consent(page, 'portable'))
    const query = await staged('sqlite', () => sqlite(page, 'portable', database))
    const shutdown = await staged('shutdown', () => closeApplication(page, owned))
    result = { transport: 'chromium.connectOverCDP', disposableUserData: true, promptObserved: true, render: render.observations, declined: true, reporting: state, sqlite: query, syntheticOnly: true, cdpPort: Number(new URL(endpoint).port), process: { wrapperPid: owned.child.pid, ...summary(application), commandLine: application.commandLine }, liveExtractedTree: { proof: 'live extracted-tree comparison', root: live.root, files: live.files, exact: true, executable: live.executable, processStable: true }, shutdown, nsis: { extractionRemoved: !fs.existsSync(live.root) } }
  } catch (error) {
    failure = error
  }
  if (browser) {
    try { await browser.close() } catch (error) {
      if (!failure) failure = new Error(`portable disconnect: ${error.message}`, { cause: error })
    }
  }
  try {
    if (owned && await settle(owned, application)) {
      console.error('portable settlement: the owned process tree had to be force-terminated')
      if (!failure) failure = new Error('portable settlement: the owned process tree had to be force-terminated')
    }
  } catch (error) {
    console.error(`portable settlement: ${error.message}`)
    if (!failure) failure = new Error(`portable settlement: ${error.message}`, { cause: error })
    failure.unsettled = true
  }
  if (failure) throw failure
  return result
}

const verify = async () => {
  assert.equal(process.platform, 'win32', 'Windows package/signature checks require Windows')
  const mode = process.env.RELEASE_MODE || 'unsigned'
  assert.ok(['unsigned', 'production'].includes(mode))
  fs.mkdirSync(EVIDENCE, { recursive: true })
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-package-'))
  let report
  let failure = null
  try {
    const metadata = { inner: inspect(INNER), wrapper: inspect(WRAPPER) }
    for (const [name, entry] of Object.entries(metadata)) {
      assert.equal(entry.Product, PRODUCT)
      assert.equal(entry.ProductVersion, stage(name === 'wrapper' ? 'portable' : name).productVersion)
      assert.equal(entry.FileVersion, VERSION)
    }
    for (const [name, filename] of [['inner-app', INNER_NAME], ['portable', WRAPPER_NAME]]) {
      const xml = fs.readFileSync(path.join(ROOT, '.github/signpath', `${name}.xml`), 'utf8')
      const productVersion = name === 'inner-app' ? `${VERSION_TOKEN}.0` : VERSION_TOKEN
      assert.ok(xml.includes(`path="${name === 'inner-app' ? filename : `aurora-electrons-${VERSION_TOKEN}.exe`}"`) && xml.includes('product-name="Aurora Electrons"') && xml.includes(`product-version="${productVersion}"`) && xml.includes(`file-version="${VERSION_TOKEN}"`), 'PE metadata agrees with exact artifact restrictions')
      assert.equal((xml.match(/<pe-file\s/g) || []).length, 1)
      assert.equal(xml.includes('*'), false, 'never select upstream dependencies')
    }
    const baseline = readJson(path.join(STATE, 'inner.json'))
    assert.equal(baseline.sourceSha, sourceSha())
    assert.equal(baseline.runId, process.env.GITHUB_RUN_ID || null)
    assert.equal(baseline.attempt, process.env.GITHUB_RUN_ATTEMPT || null)
    let signatures
    let innerHash
    if (mode === 'production') {
      const wrapperState = readJson(path.join(STATE, 'portable.json'))
      assert.ok(baseline.accepted && wrapperState.accepted, 'both signed returns must have passed shared verification')
      signatures = { inner: powershell([...identityArgs(INNER, process.env.SIGNPATH_EXPECTED_SUBJECT, PRODUCT, INNER_PRODUCT_VERSION, VERSION), '-OriginalPath', path.join(STATE, 'inner.original.exe')]), wrapper: powershell([...identityArgs(WRAPPER, process.env.SIGNPATH_EXPECTED_SUBJECT, PRODUCT, VERSION, VERSION), '-OriginalPath', path.join(STATE, 'portable.original.exe')]) }
      assert.equal(signatures.inner.SHA256, baseline.accepted.SHA256)
      assert.equal(signatures.wrapper.SHA256, wrapperState.accepted.SHA256)
      innerHash = baseline.accepted.SHA256
      assertPayload(baseline.payload, innerHash)
    } else {
      assert.equal(metadata.inner.Status, 'NotSigned', 'unsigned app must not be labelled signed')
      assert.equal(metadata.wrapper.Status, 'NotSigned', 'unsigned wrapper must not be labelled signed')
      innerHash = baseline.originalHash
      assertPayload(baseline.payload, innerHash)
      signatures = { status: 'unsigned; no project signing requested' }
    }
    const inspection = await inspectPackage()
    const controls = signatureControls(scratch)
    for (const directory of [path.dirname(WRAPPER), UNPACKED]) assert.equal(fs.existsSync(path.join(directory, 'AuroraDB.db')), false, `refusing to launch beside a real save: ${directory}`)
    const launch = { inner: await launchInner(scratch), portable: await launchPortable(scratch, { payload: baseline.payload, innerHash }) }
    report = { passed: true, sourceSha: sourceSha(), runId: process.env.GITHUB_RUN_ID || null, attempt: process.env.GITHUB_RUN_ATTEMPT || null, version: VERSION, mode, toolchain: { node: process.version, electronBuilder: require('app-builder-lib/package.json').version, electron: require('electron/package.json').version, platform: process.platform, arch: process.arch }, inner: { name: INNER_NAME, sha256: fileHash(INNER) }, wrapper: { name: WRAPPER_NAME, size: fs.statSync(WRAPPER).size, sha256: fileHash(WRAPPER) }, metadata, signatures, controls, ...inspection, launch }
  } catch (error) {
    failure = error
  }
  let cleanup = null
  if (failure?.unsettled) {
    cleanup = new Error(`${scratch} left in place because the launched processes are not settled`)
  } else {
    try { removeTree(scratch) } catch (error) { cleanup = error }
  }
  if (failure) {
    if (cleanup) console.error(`Scratch cleanup did not complete: ${cleanup.message}`)
    throw failure
  }
  if (cleanup) throw cleanup
  writeJson(path.join(EVIDENCE, 'package-smoke.json'), report)
  console.log(JSON.stringify(report, null, 2))
}

const [command = 'verify', name, returned] = process.argv.slice(2)
Promise.resolve().then(() => {
  if (command === 'snapshot') return snapshot(name)
  if (command === 'accept' && returned) return accept(name, returned)
  if (command === 'verify') return verify()
  throw new Error('usage: node scripts/package-smoke.js [verify | snapshot inner|portable | accept inner|portable <returned-directory>]')
}).catch((error) => { console.error(error); process.exitCode = 1 })
