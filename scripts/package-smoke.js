// Inspects and launches the actual two-stage Windows package; never opens a game save.
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { createRequire } = require('module')
const { spawnSync } = require('child_process')
const VERSION = require('../package.json').version
const assert = require('./lib/bounded-assert')
const { removeTree } = require('./lib/scratch-tree')
const { checkPackaged } = require('./lib/native-check')

const ROOT = path.resolve(__dirname, '..')
const PRODUCT = 'Aurora Electrons'
const INNER_NAME = `${PRODUCT}.exe`
const WRAPPER_NAME = `aurora-electrons-${VERSION}.exe`
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
const powershell = (args, { reject = false } = {}) => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'verify-signature.ps1'), ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })
  if (result.error) throw result.error
  if (reject) {
    assert.notEqual(result.status, 0, 'shared verifier rejects negative control')
    return { rejected: true }
  }
  if (result.status !== 0) throw new Error(`Shared signature verifier failed: ${result.stdout}\n${result.stderr}`)
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())
}
const inspect = (file) => powershell(['-Path', file, '-Inspect'])
const identityArgs = (file, subject, product = PRODUCT, version = VERSION) => ['-Path', file, '-ExpectedFileName', path.basename(file), '-ExpectedSubject', subject, '-ExpectedProduct', product, '-ExpectedVersion', version]
const walk = (directory, prefix = '') => {
  assert.equal(fs.lstatSync(directory).isSymbolicLink(), false, 'package/return root is not a reparse point')
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    const target = path.join(directory, entry.name)
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false, `No package reparse point: ${relative}`)
    return entry.isDirectory() ? walk(target, relative) : [relative]
  })
}
const treeHashes = () => Object.fromEntries(walk(UNPACKED).map((relative) => [relative, fileHash(path.join(UNPACKED, relative))]))
const assertPayload = (baseline, innerHash) => {
  const current = treeHashes()
  assert.deepEqual(Object.keys(current).sort(), Object.keys(baseline).sort(), 'same complete upstream/application file set')
  for (const name of Object.keys(baseline)) assert.equal(current[name], name === INNER_NAME ? innerHash : baseline[name], `preserved exact payload: ${name}`)
}
const stage = (name) => {
  assert.ok(['inner', 'portable'].includes(name), 'known signing stage')
  return name === 'inner' ? { target: INNER, name: INNER_NAME } : { target: WRAPPER, name: WRAPPER_NAME }
}
const snapshot = (name) => {
  const target = stage(name)
  fs.mkdirSync(STATE, { recursive: true })
  const original = path.join(STATE, `${name}.original.exe`)
  assert.equal(fs.existsSync(original), false, 'refusing a stale signing-state directory; use a fresh build workspace')
  fs.copyFileSync(target.target, original)
  const metadata = inspect(target.target)
  assert.equal(metadata.Product, PRODUCT)
  assert.equal(metadata.Version, VERSION)
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
  const verified = powershell([...identityArgs(signed, subject), '-OriginalPath', original])
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
    if (result.Status === 'Valid' && result.TimestampPresent && result.Subject && result.Product && result.Version) { control = { file, result }; break }
  }
  assert.ok(control, 'a real trusted timestamped upstream/system positive control is required; SIGNATURE_CONTROL can name one')
  const { file, result } = control
  powershell([...identityArgs(file, result.Subject, result.Product, result.Version), '-OriginalPath', file])
  powershell(identityArgs(file, 'CN=Wrong publisher', result.Product, result.Version), { reject: true })
  powershell(identityArgs(file, result.Subject, 'Wrong product', result.Version), { reject: true })
  powershell(identityArgs(file, result.Subject, result.Product, '999.999.999'), { reject: true })
  const tampered = path.join(scratch, path.basename(file))
  const bytes = fs.readFileSync(file)
  // Alter a code section byte, not the Authenticode-excluded checksum/certificate directory.
  const pe = bytes.readUInt32LE(0x3c)
  const section = pe + 24 + bytes.readUInt16LE(pe + 20)
  const raw = bytes.readUInt32LE(section + 20)
  assert.ok(raw > section && raw < bytes.length)
  bytes[raw] ^= 1
  fs.writeFileSync(tampered, bytes)
  powershell(identityArgs(tampered, result.Subject, result.Product, result.Version), { reject: true })
  powershell([...identityArgs(file, result.Subject, result.Product, result.Version), '-OriginalPath', tampered], { reject: true })
  const unsigned = path.join(scratch, 'unsigned.exe')
  const unsignedBytes = fs.readFileSync(file)
  const optional = pe + 24
  const directory = optional + (unsignedBytes.readUInt16LE(optional) === 0x20b ? 112 : 96) + 32
  const certificateOffset = unsignedBytes.readUInt32LE(directory)
  assert.ok(certificateOffset > 0 && certificateOffset < unsignedBytes.length, 'positive control carries embedded Authenticode data')
  unsignedBytes.fill(0, directory, directory + 8)
  fs.writeFileSync(unsigned, unsignedBytes.subarray(0, certificateOffset))
  powershell(identityArgs(unsigned, result.Subject, result.Product, result.Version), { reject: true })
  powershell([...identityArgs(file, result.Subject, result.Product, result.Version), '-OriginalPath', unsigned])
  const decisions = powershell(['-SelfTest'])
  return { positive: { name: path.basename(file), ...result }, unsignedOriginalToTrustedSigned: { passed: true, originalSHA256: fileHash(unsigned), signedSHA256: result.SHA256 }, existingCertificatePreserved: true, negativeControls: ['unsigned', 'tampered code', 'changed original PE payload', 'wrong subject', 'wrong ProductName', 'wrong ProductVersion'], decisions, scope: 'Trusted upstream/system binary only; not an Aurora project signature' }
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
  assert.ok(files.some((file) => /node_modules\/sqlite3\/.*node_sqlite3\.node$/.test(file) && asar.statFile(archive, file).unpacked), 'asar maps SQLite to the unpacked native file')
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
    const info = JSON.parse(asar.extractFile(archive, file).toString('utf8'))
    const directory = file.slice(0, -'package.json'.length)
    const licenses = files.filter((entry) => entry.startsWith(directory) && !entry.slice(directory.length).includes('/') && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(entry.slice(directory.length)))
    assert.ok(licenses.length, `required upstream licence text for ${info.name}@${info.version}`)
    licenses.forEach((entry) => assert.ok(asar.extractFile(archive, entry).length > 0, `nonempty ${entry}`))
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
  const rendererText = files.filter((file) => /^out\/renderer\/.*\.(js|html)$/.test(file)).map((file) => asar.extractFile(archive, file).toString('utf8')).join('\n')
  assert.ok(rendererText.includes('skoormit') && rendererText.includes('MIT License'), 'existing in-app credits and licence text survive bundling')
  assert.ok(fs.readFileSync(path.join(resources, 'LICENSE.nsis.txt'), 'utf8').includes('bzip2'), 'complete NSIS toolset notice')
  return { asar: { sha256: fileHash(archive), entries: files.length }, upstream, native: native.map((name) => ({ name, sha256: fileHash(path.join(UNPACKED, name)) })), notices: { root: ['LICENSE', 'THIRD_PARTY_NOTICES.md'], upstream: ['LICENSE.electron.txt', 'LICENSES.chromium.html', 'resources/LICENSE.nsis.txt'], packages, coveredPackages, omittedPackageControl: 'sqlite3', wrongVersionControl: 'sqlite3@999.999.999', inApp: true }, sevenZip: builderRequire('7zip-bin').path7za }
}

const wrapperPayload = (sevenZip, scratch) => {
  const extracted = path.join(scratch, 'wrapper')
  fs.mkdirSync(extracted)
  run(sevenZip, ['x', '-y', WRAPPER, `-o${extracted}`])
  const targets = walk(extracted).filter((name) => path.basename(name) === INNER_NAME).map((name) => path.join(extracted, name))
  assert.equal(targets.length, 1, 'one exact inner executable in wrapper')
  assert.equal(fileHash(targets[0]), fileHash(INNER), 'wrapper embeds exact verified inner bytes')
  // Verify the entire embedded payload, not merely the signable executable.
  const payloadRoot = path.dirname(targets[0])
  const expected = treeHashes()
  const actual = Object.fromEntries(walk(payloadRoot).map((name) => [name, fileHash(path.join(payloadRoot, name))]))
  const supportFiles = Object.keys(actual).filter((name) => !Object.hasOwn(expected, name))
  assert.ok(supportFiles.every((name) => name.startsWith('$PLUGINSDIR/')), 'only NSIS support files outside the application payload')
  for (const [name, sha256] of Object.entries(expected)) assert.equal(actual[name], sha256, `wrapper embeds exact upstream/application bytes: ${name}`)
  return { innerSHA256: fileHash(targets[0]), completePayloadFiles: Object.keys(expected).length, wrapperSupportFiles: supportFiles }
}

const launchPackage = async (scratch, name, executablePath) => {
  const { _electron } = require('playwright')
  const work = path.join(scratch, name)
  fs.mkdirSync(work)
  const userData = path.join(work, 'user-data')
  const database = path.join(work, 'synthetic.db')
  const env = { ...process.env }
  for (const key of ['AURORA_DB', 'ELECTRON_RENDERER_URL', 'ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_APP_FILENAME']) delete env[key]
  for (const [key, folder] of [['APPDATA', 'appdata'], ['LOCALAPPDATA', 'localappdata'], ['USERPROFILE', 'home'], ['HOME', 'home']]) {
    env[key] = path.join(work, folder)
    fs.mkdirSync(env[key], { recursive: true })
  }
  const app = await _electron.launch({ executablePath, args: [`--user-data-dir=${userData}`], cwd: work, env, timeout: 90000 })
  let result
  let failure = null
  try {
    const actual = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), packaged: app.isPackaged, appPath: app.getAppPath() }))
    assert.equal(path.resolve(actual.userData).toLowerCase(), path.resolve(userData).toLowerCase(), 'disposable userData, never owner settings')
    assert.equal(actual.packaged, true)
    const page = await app.firstWindow({ timeout: 90000 })
    await page.locator('[data-reporting-prompt]').waitFor({ state: 'visible', timeout: 90000 })
    await page.screenshot({ path: path.join(EVIDENCE, `${name}-first-choice.png`) })
    await page.locator('[data-reporting-decline]').click()
    await page.locator('[data-reporting-prompt]').waitFor({ state: 'hidden', timeout: 30000 })
    const state = await page.evaluate(() => window.__aurora.reporting.state())
    assert.equal(state.savedChoice, false)
    assert.equal(state.enabled, false)
    assert.equal(state.initialized, false)
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

const verify = async () => {
  assert.equal(process.platform, 'win32', 'Windows package/signature checks require Windows')
  const mode = process.env.RELEASE_MODE || 'unsigned'
  assert.ok(['unsigned', 'production'].includes(mode))
  fs.mkdirSync(EVIDENCE, { recursive: true })
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-package-'))
  try {
    const metadata = { inner: inspect(INNER), wrapper: inspect(WRAPPER) }
    for (const entry of Object.values(metadata)) { assert.equal(entry.Product, PRODUCT); assert.equal(entry.Version, VERSION) }
    for (const [name, filename] of [['inner-app', INNER_NAME], ['portable', WRAPPER_NAME]]) {
      const xml = fs.readFileSync(path.join(ROOT, '.github/signpath', `${name}.xml`), 'utf8')
      assert.ok(xml.includes(`path="${name === 'inner-app' ? filename : `aurora-electrons-${VERSION_TOKEN}.exe`}"`) && xml.includes('product-name="Aurora Electrons"') && xml.includes(`product-version="${VERSION_TOKEN}"`), 'PE metadata agrees with exact artifact restrictions')
      assert.equal((xml.match(/<pe-file\s/g) || []).length, 1)
      assert.equal(xml.includes('*'), false, 'never select upstream dependencies')
    }
    const baseline = readJson(path.join(STATE, 'inner.json'))
    assert.equal(baseline.sourceSha, sourceSha())
    assert.equal(baseline.runId, process.env.GITHUB_RUN_ID || null)
    assert.equal(baseline.attempt, process.env.GITHUB_RUN_ATTEMPT || null)
    let signatures
    if (mode === 'production') {
      const wrapperState = readJson(path.join(STATE, 'portable.json'))
      assert.ok(baseline.accepted && wrapperState.accepted, 'both signed returns must have passed shared verification')
      signatures = { inner: powershell([...identityArgs(INNER, process.env.SIGNPATH_EXPECTED_SUBJECT), '-OriginalPath', path.join(STATE, 'inner.original.exe')]), wrapper: powershell([...identityArgs(WRAPPER, process.env.SIGNPATH_EXPECTED_SUBJECT), '-OriginalPath', path.join(STATE, 'portable.original.exe')]) }
      assert.equal(signatures.inner.SHA256, baseline.accepted.SHA256)
      assert.equal(signatures.wrapper.SHA256, wrapperState.accepted.SHA256)
      assertPayload(baseline.payload, baseline.accepted.SHA256)
    } else {
      assert.equal(metadata.inner.Status, 'NotSigned', 'unsigned app must not be labelled signed')
      assert.equal(metadata.wrapper.Status, 'NotSigned', 'unsigned wrapper must not be labelled signed')
      assertPayload(baseline.payload, baseline.originalHash)
      signatures = { status: 'unsigned; no project signing requested' }
    }
    const inspection = await inspectPackage()
    const wrapper = wrapperPayload(inspection.sevenZip, scratch)
    delete inspection.sevenZip
    const controls = signatureControls(scratch)
    const launch = { inner: await launchPackage(scratch, 'inner', INNER), portable: await launchPackage(scratch, 'portable', WRAPPER) }
    const report = { passed: true, sourceSha: sourceSha(), runId: process.env.GITHUB_RUN_ID || null, attempt: process.env.GITHUB_RUN_ATTEMPT || null, version: VERSION, mode, toolchain: { node: process.version, electronBuilder: require('app-builder-lib/package.json').version, electron: require('electron/package.json').version, platform: process.platform, arch: process.arch }, inner: { name: INNER_NAME, sha256: fileHash(INNER) }, wrapper: { name: WRAPPER_NAME, size: fs.statSync(WRAPPER).size, sha256: fileHash(WRAPPER), ...wrapper }, metadata, signatures, controls, ...inspection, launch }
    writeJson(path.join(EVIDENCE, 'package-smoke.json'), report)
    console.log(JSON.stringify(report, null, 2))
  } finally {
    removeTree(scratch)
  }
}

const [command = 'verify', name, returned] = process.argv.slice(2)
Promise.resolve().then(() => {
  if (command === 'snapshot') return snapshot(name)
  if (command === 'accept' && returned) return accept(name, returned)
  if (command === 'verify') return verify()
  throw new Error('usage: node scripts/package-smoke.js [verify | snapshot inner|portable | accept inner|portable <returned-directory>]')
}).catch((error) => { console.error(error); process.exitCode = 1 })
