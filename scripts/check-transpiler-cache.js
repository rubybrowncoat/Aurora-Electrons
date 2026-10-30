/*
  Checks that the check scripts leave nothing in Bun's runtime transpiler cache for what their child processes load (scripts/lib/check-pool.js, runChild) or for the modules they generate (scripts/lib/module-files.js).

  bun scripts/check-transpiler-cache.js [--no-mutations]

  Bun keeps a transpiled copy of every source file over 4 KB that it loads, found by the file's text alone and never removed: in ~/.bun/install/cache/@t@, or in the folder BUN_RUNTIME_TRANSPILER_CACHE_PATH names, while "0" turns the cache off. Only the environment a process starts with counts. Each check points the cache of the processes it starts at a folder of its own and counts the files they add:
  - a child that runChild starts adds nothing, even when the caller hands it a cache folder;
  - a second process that loads the same generated modules adds nothing, the first having added their copies, and both load the right values.
  Each planted fault rewrites one line of a copy of scripts/lib and must make its check fail; each equivalent rewrite must leave every check passing.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { runChild } = require('./lib/check-pool')

const CACHE = 'BUN_RUNTIME_TRANSPILER_CACHE_PATH'
// The leaf is too long for a data URL (scripts/lib/module-files.js) and so is a file; the middle imports it and is a file too, padded past the 4 KB under which Bun keeps no copy.
const LEAF_VALUES = 150000
const PADDING = `// ${'x'.repeat(6000)}\n`

const filesIn = (folder) => fs.readdirSync(folder, { recursive: true }).filter((entry) => fs.statSync(path.join(folder, entry)).isFile()).length

// --load: builds the leaf, the middle and the root through urlOfSource, imports the root and prints the sum it exports.
const load = async () => {
  const { urlOfSource } = require('./lib/module-files')
  const leaf = urlOfSource(`export const values = [${Array.from({ length: LEAF_VALUES }, (_value, index) => index).join(',')}]\n`)
  const middle = urlOfSource(`${PADDING}import { values } from '${leaf}'\nexport const sum = values.reduce((total, value) => total + value, 0)\n`)
  const root = urlOfSource(`import { sum } from '${middle}'\nexport default sum\n`)
  const loaded = await import(root)

  console.log(`loaded ${loaded.default}`)
}

// --drive <folder>: runs --load through runChild, handing it the folder as its cache, and prints how many files the child added there.
const drive = async (folder) => {
  const before = filesIn(folder)
  const { code, stdout, stderr } = await runChild(__filename, ['--load'], { env: { [CACHE]: folder } })

  if (code !== 0) {
    throw new Error(`the child ended with ${code}: ${stderr.trim().slice(0, 300)}`)
  }

  console.log(`added ${filesIn(folder) - before} ${stdout.trim()}`)
}

const EXPECTED = `loaded ${(LEAF_VALUES - 1) * LEAF_VALUES / 2}`

// This script in a process of its own whose cache is `folder`: its stdout, or an error naming how it ended.
const inProcess = (args, folder) => {
  const result = spawnSync(process.execPath, [__filename, ...args], { env: { ...process.env, [CACHE]: folder }, encoding: 'utf8' })

  if (result.status !== 0) {
    throw new Error(`${args.join(' ')} ended with ${result.status}: ${(result.stderr || '').trim().slice(0, 300)}`)
  }

  return result.stdout.trim()
}

const withFolder = (work) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-transpiler-cache-'))

  try {
    return work(folder)
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
}

const CHECKS = [
  ['a child that runChild starts adds nothing to the transpiler cache, even when handed a cache folder', () => withFolder((folder) => {
    const printed = inProcess(['--drive', folder], folder)

    return printed === `added 0 ${EXPECTED}` ? true : `the child printed "${printed}", expected "added 0 ${EXPECTED}"`
  })],
  ['a second process that loads the same generated modules adds nothing to the transpiler cache', () => withFolder((folder) => {
    const first = inProcess(['--load'], folder)
    const afterFirst = filesIn(folder)
    const second = inProcess(['--load'], folder)
    const added = filesIn(folder) - afterFirst

    if (first !== EXPECTED || second !== EXPECTED) {
      return `the processes printed "${first}" and "${second}", expected "${EXPECTED}"`
    }

    if (afterFirst === 0) {
      return 'the first process left no copy at all, so the cache was off and nothing was measured'
    }

    return added === 0 ? true : `the second process added ${added} file(s)`
  })],
]

const runChecks = () => CHECKS.map(([name, run]) => {
  let result

  try {
    result = run()
  } catch (error) {
    result = `threw ${error.message}`
  }

  return [name, result]
})

// [label, file under scripts/lib, from, to, the checks it must fail (none for an equivalent rewrite)]
const MUTATIONS = [
  ['runChild hands the child the caller environment unchanged', 'check-pool.js', ", ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }", ', ...env }', ['a child that runChild starts']],
  ['the caller environment overrides the cache setting of runChild', 'check-pool.js', "CHECK_JOBS: '1', ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }", "CHECK_JOBS: '1', BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0', ...env }", ['a child that runChild starts']],
  ['a generated file keeps the URL of the folder of its process', 'module-files.js', 'const text = folder === null ? source :', 'const text = source ||', ['a second process']],
  ['equivalent: runChild turns the cache off with an empty value', 'check-pool.js', "BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }", "BUN_RUNTIME_TRANSPILER_CACHE_PATH: '' }", []],
  ['equivalent: the folder is tested for absence by falsiness', 'module-files.js', 'const text = folder === null ? source :', 'const text = !folder ? source :', []],
]

// A line the copy prints, in its main run only, before its own results: a second report of a check it then reports again.
const extraLine = (line) => `if (process.argv[2] === '--no-mutations') console.log(${JSON.stringify(line)})\nconst runChild = `

// Copies whose run gives no sound result: each must be refused both as an equivalent rewrite and as a caught fault of the checks it names (every check when it names none), or a copy that never ran its checks, ended badly after them, reported one twice or broke more than it names would count as one that passed or failed them.
const BROKEN_COPIES = [
  ['a copy that crashes while loading its modules', 'check-pool.js', 'const runChild = ', "throw new Error('a planted crash')\nconst runChild = "],
  ['a copy that exits successfully before running a check', 'check-pool.js', 'const runChild = ', 'process.exit(0)\nconst runChild = '],
  ['a copy that reports every check passing and then ends with a failure status', 'check-pool.js', 'const runChild = ', "process.on('exit', () => { if (process.argv[2] === '--no-mutations') process.exitCode = 3 })\nconst runChild = "],
  ['a copy that reports a check as failing and then as passing', 'check-pool.js', 'const runChild = ', extraLine(`FAIL ${CHECKS[0][0]}: a planted report`)],
  ['a copy that reports a check as passing twice', 'check-pool.js', 'const runChild = ', extraLine(`ok   ${CHECKS[0][0]}`)],
  ['a fault that breaks every check, named for the first only', 'module-files.js', 'const urlOfSource = (source) => {', "const urlOfSource = (source) => {\n  throw new Error('a planted fault')", [CHECKS[0][0]]],
]

// Runs a copy of this script and scripts/lib with `from` replaced by `to` in lib/`file`: { code, stderr, reported, repeated }. `reported` maps the name of each check the copy reported exactly once to true or the reason it failed, and leaves out a check it never reported; `repeated` names each check it reported more than once.
const runCopy = async (file, from, to) => {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-transpiler-cache-mutant-'))

  try {
    fs.mkdirSync(path.join(tree, 'lib'))
    fs.copyFileSync(__filename, path.join(tree, path.basename(__filename)))
    fs.readdirSync(path.join(__dirname, 'lib')).filter((name) => name.endsWith('.js')).forEach((name) => fs.copyFileSync(path.join(__dirname, 'lib', name), path.join(tree, 'lib', name)))

    const target = path.join(tree, 'lib', file)
    const source = fs.readFileSync(target, 'utf8')

    if (source.split(from).length !== 2) {
      throw new Error(`the rewrite of ${file} does not apply exactly once`)
    }

    fs.writeFileSync(target, source.replace(from, () => to))

    const { code, stdout, stderr } = await runChild(path.join(tree, path.basename(__filename)), ['--no-mutations'])
    const lines = stdout.split('\n').map((line) => line.trimEnd())
    const rows = CHECKS.map(([name]) => [name, lines.filter((line) => line === `ok   ${name}` || line.startsWith(`FAIL ${name}: `))])
    const reported = new Map(rows.filter(([, found]) => found.length === 1).map(([name, [line]]) => [name, line.startsWith('ok') ? true : line.slice(`FAIL ${name}: `.length)]))
    const repeated = rows.filter(([, found]) => found.length > 1).map(([name]) => name)

    return { code, stderr, reported, repeated }
  } finally {
    fs.rmSync(tree, { recursive: true, force: true })
  }
}

// What makes a copy's run unfit to judge: a check it reported more than once, or one it never reported.
const unsound = ({ code, stderr, reported, repeated }) => {
  const missing = CHECKS.map(([name]) => name).filter((name) => !reported.has(name) && !repeated.includes(name))

  if (repeated.length) {
    return `the copy reported more than once: ${repeated.join('; ')}`
  }

  return missing.length ? `the copy ended with ${code} without reporting: ${missing.join('; ')}${stderr.trim() ? ` (${stderr.trim().split('\n').pop().slice(0, 200)})` : ''}` : null
}

// An equivalent rewrite passes when its copy exits 0 having reported every check as passing.
const equivalence = (run) => {
  const failed = [...run.reported].filter(([, result]) => result !== true).map(([name, result]) => `${name}: ${result}`)

  return unsound(run) || (failed.length ? `an equivalent rewrite failed: ${failed.join('; ')}` : run.code === 0 ? true : `the copy reported every check passing but ended with ${run.code}`)
}

// A fault is caught when its copy reported every check, failed each one `fails` names and passed the others: a fault that also broke a check it does not name has broken the copy, not shown that its own check bites.
const caught = (run, fails) => {
  const named = (name) => fails.some((start) => name.startsWith(start))
  const survived = fails.filter((start) => ![...run.reported].some(([name, result]) => name.startsWith(start) && result !== true))
  const broken = [...run.reported].filter(([name, result]) => !named(name) && result !== true).map(([name, result]) => `${name}: ${result}`)

  return unsound(run) || (survived.length ? `these checks still pass: ${survived.join('; ')}` : broken.length ? `the fault also failed checks it does not name: ${broken.join('; ')}` : true)
}

const settled = async (work) => {
  try {
    return await work()
  } catch (error) {
    return `threw ${error.message}`
  }
}

const main = async () => {
  const results = runChecks()

  if (!process.argv.includes('--no-mutations')) {
    for (const [label, file, from, to, fails] of MUTATIONS) {
      results.push([`${fails.length ? 'fault caught' : 'rewrite passes'}: ${label}`, await settled(async () => {
        const run = await runCopy(file, from, to)

        return fails.length ? caught(run, fails) : equivalence(run)
      })])
    }

    for (const [label, file, from, to, fails = CHECKS.map(([name]) => name)] of BROKEN_COPIES) {
      results.push([`refused as a rewrite and as a fault: ${label}`, await settled(async () => {
        const run = await runCopy(file, from, to)
        const accepted = [['an equivalent rewrite that passes', equivalence(run)], ['a caught fault', caught(run, fails)]].filter(([, verdict]) => verdict === true)

        return accepted.length ? `the copy counted as ${accepted.map(([what]) => what).join(' and as ')}` : true
      })])
    }
  }

  results.forEach(([name, result]) => console.log(result === true ? `ok   ${name}` : `FAIL ${name}: ${result}`))

  const passed = results.filter(([, result]) => result === true).length

  console.log(`\n${passed} of ${results.length} checks passed`)
  process.exit(passed === results.length ? 0 : 1)
}

if (process.argv[2] === '--load') {
  load().catch((error) => {
    console.error(error)
    process.exit(2)
  })
} else if (process.argv[2] === '--drive') {
  drive(process.argv[3]).catch((error) => {
    console.error(error)
    process.exit(2)
  })
} else {
  main().catch((error) => {
    console.error(error)
    process.exit(2)
  })
}
