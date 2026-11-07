/* Per-iteration selection is static: print fast/deep commands without starting a check. Landing plan/verify remains separate. */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { hash, repoFiles, planChanges, verifyEvidence } = require('./lib/affected-checks')

const git = (root, args, options = {}) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options })
const snapshot = (root, ref) => {
  const commit = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim()
  const names = git(root, ['ls-tree', '-r', '-z', '--name-only', commit]).split('\0').filter((file) => /^(?:src|scripts)\/.*\.(?:js|mjs|vue|json|css|styl|scss|html|ts|md|py|ps1|sh|txt|yml|yaml|svg)$/.test(file) || ['package.json', 'bun.lock'].includes(file)).sort()
  if (names.some((name) => /[\r\n]/.test(name))) throw new Error('newline paths are not supported by the source snapshot')
  const batch = git(root, ['cat-file', '--batch'], { encoding: null, input: names.map((file) => `${commit}:${file}\n`).join('') })
  const sources = {}
  let offset = 0
  for (const file of names) {
    const end = batch.indexOf(10, offset)
    const header = batch.subarray(offset, end).toString('utf8')
    if (!/^[a-f0-9]+ blob \d+$/.test(header)) throw new Error(`cannot read source snapshot ${file}: ${header}`)
    const size = Number(header.split(' ')[2])
    sources[file] = batch.subarray(end + 1, end + 1 + size).toString('utf8')
    offset = end + 1 + size + 1
  }
  return { commit, sources }
}
const changedPaths = (root, base, candidate) => {
  // --no-renames deliberately includes both sides as a deletion and addition; neither old nor new targets disappear.
  return git(root, ['diff', '--no-renames', '--name-only', '-z', base, candidate]).split('\0').filter(Boolean).sort()
}
const cleanSources = (root) => {
  const dirty = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']).split('\0').filter((line) => line && (!line.startsWith('?? ') || /^(?:src|scripts)\//.test(line.slice(3))))
  if (dirty.length) throw new Error(`commit or restore source changes before a landing plan: ${dirty.join(', ')}`)
}
const optionsOf = (argv) => {
  const explicit = argv[0] && !argv[0].startsWith('--')
  const options = { command: explicit ? argv[0] : 'select', root: path.resolve(__dirname, '..'), changed: [], mode: 'fast' }
  for (let index = explicit ? 1 : 0; index < argv.length; index++) {
    const key = argv[index]
    if (key === '--deep') { options.mode = 'deep'; continue }
    if (!['--root', '--base', '--candidate', '--changed', '--out', '--plan', '--runs', '--mode'].includes(key) || !argv[index + 1]) throw new Error(`unknown or incomplete option ${key}`)
    if (key === '--changed') options.changed.push(argv[++index])
    else options[key.slice(2)] = argv[++index]
  }
  if (!['fast', 'deep'].includes(options.mode)) throw new Error('--mode must be fast or deep')
  return options
}
const workingPaths = (root, base = 'HEAD') => [...new Set([
  ...git(root, ['diff', '--no-renames', '--name-only', '-z', base]).split('\0'),
  ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
].filter(Boolean))].sort()
const shellWord = (word) => /^[\w./:=,-]+$/.test(word) ? word : '"' + word.replace(/"/g, '\\"') + '"'
const runCommand = (selections, key) => selections.flatMap((selection) => selection[key].map((command) => ['bun', selection.suite, ...command.args].map(shellWord).join(' '))).join(' && ')
const printPlan = (plan) => {
  const reached = plan.selections.length
  const sharedChange = plan.changed.some((file) => file.startsWith('scripts/lib/')) && reached > 1
  const broad = sharedChange || (reached > 0 && reached >= plan.suiteCount * 0.8)
  const conciseReasons = (reasons) => {
    const seen = new Set()
    return reasons.flatMap(({ key: _key, issues, ...reason }) => {
      const identity = JSON.stringify([reason.reason, reason.file, reason.line, reason.target])
      if (seen.has(identity)) return []
      seen.add(identity)
      return [{ ...reason, ...(issues?.length ? { firstIssue: issues[0], issueCount: issues.length } : {}) }]
    })
  }
  console.log(JSON.stringify({
    status: plan.status,
    identity: plan.identity,
    digest: plan.digest,
    changed: plan.changed,
    coverage: `${reached} of ${plan.suiteCount} scripts`,
    ...(broad ? { sweep: `this diff reaches ${reached} of ${plan.suiteCount} scripts; run the sweep`, suggestedFast: 'bun run check:quick', suggestedDeep: 'bun run check' } : {}),
    preferredMode: sharedChange ? 'deep (shared check infrastructure)' : 'fast',
    selected: plan.selections.map(({ suite, keys, reasons, commands, fastCommands, deepCommands }) => ({ suite, variants: keys.length, reasons: conciseReasons(reasons), commands, fastCommands, deepCommands })),
    fastCommand: runCommand(plan.selections, 'fastCommands'),
    deepCommand: runCommand(plan.selections, 'deepCommands'),
    mode: plan.identity.depth || 'deep',
    widenings: plan.widenings,
    analysedBindings: plan.analysedBindings,
    blockers: plan.blockers,
    note: 'Fast runs heads only (--no-mutations). Deep adds selected faults/rewrites. Shared helpers can require the sweep; neither diagnostic mode approves a landing.',
  }, null, 2))
}
// PASS details have a dedicated two-space bracket suffix; names themselves stay exact.
const passNames = (log) => log.split(/\r?\n/).filter((line) => /^PASS\s/.test(line)).map((line) => line.replace(/^PASS\s+/, '').replace(/ {2}\[.*\]$/, ''))
const uniqueWitnesses = (observed, expected, exact = false) => {
  if (!expected.length || expected.some((name) => typeof name !== 'string' || /[\r\n]/.test(name)) || new Set(expected).size !== expected.length || expected.some((name) => observed.filter((one) => one === name).length !== 1) || (exact && observed.length !== expected.length)) throw new Error('selected variants have no complete unique execution witnesses')
}
const rawEvidence = (plan, index) => {
  if (!Array.isArray(index)) throw new Error('the run index is an array of supervised record locations')
  const records = index.map((entry) => {
    if (!entry.suite || !entry.status || !entry.log) throw new Error('every run names its suite and raw status and log files')
    const status = JSON.parse(fs.readFileSync(entry.status, 'utf8'))
    const log = fs.readFileSync(entry.log, 'utf8')
    const supervisorRoot = path.dirname(path.dirname(path.dirname(path.resolve(entry.status))))
    if (path.basename(entry.status) !== 'status.json' || path.dirname(path.resolve(entry.log)) !== path.dirname(path.resolve(entry.status)) || path.resolve(supervisorRoot, status.script) !== path.resolve(plan.identity.root, entry.suite)) throw new Error('the supervisor belongs to another checkout or suite')
    if (!(Date.parse(status.started) >= Date.parse(plan.createdAt)) || !(Date.parse(status.ended) >= Date.parse(status.started))) throw new Error('the run predates the plan or has invalid timestamps')
    const selection = plan.selections.find((one) => one.suite === entry.suite)
    if (!selection || !String(status.script).replace(/\\/g, '/').endsWith(entry.suite)) throw new Error(`supervisor names another suite: ${entry.suite}`)
    if (status.state !== 'done' || status.code !== 0 || !status.started || !status.ended || !/\d+ of \d+ checks passed/.test(status.summary || '') || !log.includes(status.summary)) throw new Error(`supervisor did not complete successfully: ${entry.suite}`)
    const completed = /^(\d+) of (\d+) checks passed$/.exec(status.summary)
    const summaries = [...log.matchAll(/^(\d+) of (\d+) checks passed$/gm)]
    if (!completed || !Number.isSafeInteger(Number(completed[2])) || Number(completed[2]) <= 0 || completed[1] !== completed[2] || summaries.at(-1)?.[0] !== status.summary) throw new Error('authoritative completed summary must be positive, all-passed and agree with status')
    const args = status.args || []
    if ((args.includes('--no-mutations') || entry.quick) && !(selection.family === 'full' && JSON.stringify(args) === '["--no-mutations"]')) throw new Error('a quick head cannot satisfy anchor-variant evidence')
    let keys = []
    let completeDefault = false
    if (selection.family === 'runner') {
      if (!entry.progress) throw new Error('a suite-runner run needs its exact progress record')
      const rows = fs.readFileSync(entry.progress, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
      const header = rows.shift()
      if (!(Date.parse(header.began) >= Date.parse(plan.createdAt)) || !(Date.parse(header.began) >= Date.parse(status.started)) || !(Date.parse(header.began) <= Date.parse(status.ended))) throw new Error('progress predates this plan or belongs to another run')
      if (JSON.stringify(header.args) !== JSON.stringify(args) || !String(header.script).endsWith(entry.suite)) throw new Error('progress header does not match supervisor arguments')
      if (rows.some((row) => row.failures || row.harness || !(row.checks > 0))) throw new Error('progress holds a failed or unobserved variant')
      const declared = header.variants.map(([key]) => key)
      const completedKeys = new Set(rows.map((row) => row.key))
      if (new Set(declared).size !== declared.length || completedKeys.size !== rows.length || rows.length !== declared.length || declared.some((key) => !completedKeys.has(key))) throw new Error('progress is missing or repeats a selected variant')
      const counted = /^(\d+) of (\d+) checks passed$/.exec(status.summary)
      if (!counted || Number(counted[2]) !== rows.reduce((sum, row) => sum + row.checks, 0)) throw new Error('supervisor and variant counts disagree')
      keys = declared
      completeDefault = args.every((argument) => argument === '--detail') && Array.isArray(selection.defaultKeys) && selection.defaultKeys.every((key) => keys.includes(key))
    } else if (selection.family === 'only-keys') {
      const match = args.find((arg) => arg.startsWith('--only='))
      if (!args.includes('--detail')) throw new Error('route-position evidence needs --detail execution witnesses')
      const expected = selection.commands.find((command) => JSON.stringify(command.args) === JSON.stringify(args))
      const full = !match && args.length === 1 && Array.isArray(selection.defaultKeys)
      if (!expected && !full) throw new Error('missing head execution witness')
      keys = full ? selection.defaultKeys : expected.keys
      const observed = [...log.matchAll(/^TIME (.+): \d+(?:\.\d+)? s(?:; RSS \d+(?:\.\d+)? MiB)?$/gm)].map((match) => match[1])
      uniqueWitnesses(observed, keys.map((key) => selection.timingWitnesses?.[key]), true)
      completeDefault = full
    } else if (selection.family === 'part') {
      if (!args.length && Array.isArray(selection.defaultKeys) && selection.partWitnesses) {
        const passing = passNames(log)
        try { uniqueWitnesses(passing, Object.values(selection.partWitnesses)) } catch { throw new Error('full part run lacks exact unique named mutation or rewrite witnesses') }
        keys = selection.defaultKeys
        completeDefault = true
      } else {
        const key = args[0] === '--part' && args.length === 2 ? args[1] : null
        if (!key) throw new Error('route-time evidence needs one exact --part argument or a proven complete default run')
        keys = [key]
        if (key !== 'head') uniqueWitnesses(passNames(log), [selection.partWitnesses?.[key]])
      }
    } else if (selection.family === 'full') {
      if (JSON.stringify(args) === '["--no-mutations"]' && selection.expectedExtra !== null) keys = ['head']
      else {
        if (args.length) throw new Error('fallback evidence must use the complete unfiltered default catalog')
        if (selection.witnesses) {
          const passing = passNames(log)
          uniqueWitnesses(passing, selection.witnesses.faults.map((name) => 'fault caught: ' + name))
          if (selection.witnesses.benign.some((name) => name.includes('; ') || /[\r\n]/.test(name))) throw new Error('ambiguous rewrite execution identity')
          const rewrites = passing.flatMap((name) => name.startsWith('rewrite passes: ') ? [name.slice('rewrite passes: '.length)] : name.startsWith('rewrites pass together: ') ? name.slice('rewrites pass together: '.length).split('; ') : [])
          uniqueWitnesses(rewrites, selection.witnesses.benign, true)
        }
        keys = ['*']
      }
    }
    return { suite: entry.suite, args, keys, completeDefault, code: status.code, sourceHash: selection.sourceHash, checks: Number(/^(\d+) of (\d+) checks passed$/.exec(status.summary)?.[2]) }
  })
  for (const selection of plan.selections.filter((entry) => entry.family === 'full' && entry.expectedExtra !== null)) {
    const head = records.find((entry) => entry.suite === selection.suite && entry.keys.includes('head'))
    const full = records.find((entry) => entry.suite === selection.suite && entry.keys.includes('*'))
    if (!head || !full || full.checks !== head.checks + selection.expectedExtra) throw new Error('full fallback counts do not prove its complete mutation/rewrite catalog')
  }
  return records
}
const main = async (argv = process.argv.slice(2)) => {
  const options = optionsOf(argv)
  const root = path.resolve(options.root)
  if (options.command === 'select') {
    if (options.candidate) throw new Error('--candidate belongs to a committed landing plan, not the working-tree loop')
    const sources = Object.fromEntries(repoFiles(root).map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]))
    const before = snapshot(root, options.base || 'HEAD')
    const changed = options.changed.length ? options.changed : workingPaths(root, before.commit)
    const plan = await planChanges({ root, sources, baseline: before.sources, changed, identity: { mode: 'working-tree', depth: options.mode, root, platform: process.platform, landingGate: false } })
    if (options.out) fs.writeFileSync(options.out, JSON.stringify(plan, null, 2) + '\n')
    printPlan(plan)
    return plan.status === 'ready-for-runs' ? 0 : 1
  }
  if (options.command === 'plan') {
    let sources
    let baseline
    let changed
    let identity
    if (options.changed.length) {
      if (options.base) throw new Error('explicit diagnostic paths and a landing base cannot be mixed')
      sources = Object.fromEntries(repoFiles(root).map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]))
      baseline = sources
      changed = options.changed
      identity = { mode: 'explicit-paths', root, platform: process.platform, landingGate: false }
    } else {
      if (!options.base) throw new Error('a landing plan requires --base; --changed is diagnostic only')
      cleanSources(root)
      const before = snapshot(root, options.base)
      const after = snapshot(root, options.candidate || 'HEAD')
      if (after.commit !== git(root, ['rev-parse', 'HEAD']).trim()) throw new Error('the candidate must be the checkout HEAD used for the runs')
      sources = after.sources
      baseline = before.sources
      changed = changedPaths(root, before.commit, after.commit)
      identity = { mode: 'git-diff', root, base: before.commit, candidate: after.commit, platform: process.platform, landingGate: true }
    }
    const plan = await planChanges({ root, sources, baseline, changed, identity })
    if (options.out) fs.writeFileSync(options.out, JSON.stringify(plan, null, 2) + '\n')
    printPlan(plan)
    return plan.status === 'ready-for-runs' ? 0 : 1
  }
  if (options.command === 'verify') {
    if (!options.plan || !options.runs) throw new Error('verify requires --plan and --runs')
    const plan = JSON.parse(fs.readFileSync(options.plan, 'utf8'))
    if (!plan.identity.landingGate || plan.identity.mode !== 'git-diff' || path.resolve(plan.identity.root) !== root) throw new Error('a diagnostic or other-checkout plan cannot approve a landing')
    cleanSources(root)
    const current = snapshot(root, 'HEAD')
    if (current.commit !== plan.identity.candidate) throw new Error('the candidate commit changed after planning')
    const before = snapshot(root, plan.identity.base)
    const refreshed = await planChanges({ root, sources: current.sources, baseline: before.sources, changed: changedPaths(root, before.commit, current.commit), identity: plan.identity, createdAt: plan.createdAt })
    if (refreshed.digest !== plan.digest) throw new Error('the plan no longer matches complete anchor discovery for this base and candidate')
    const fingerprints = Object.fromEntries(Object.entries(current.sources).sort(([a], [b]) => a.localeCompare(b)).map(([file, text]) => [file, hash(text)]))
    const result = verifyEvidence(plan, rawEvidence(plan, JSON.parse(fs.readFileSync(options.runs, 'utf8'))), fingerprints)
    console.log(JSON.stringify(result))
    return 0
  }
  throw new Error('usage: affected-checks.js [select] [--changed <path>] [--mode fast|deep] [--out <json>] | plan --base <commit> | plan --changed <path> | verify --plan <json> --runs <json> [--root <checkout>]')
}

if (require.main === module) main().then((code) => { process.exitCode = code }, (error) => { console.error(error.message); process.exitCode = 2 })
module.exports = { main, snapshot, changedPaths, cleanSources, optionsOf, rawEvidence, workingPaths, printPlan, runCommand }
