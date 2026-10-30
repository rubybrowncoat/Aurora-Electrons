/*
  Checks the guard that keeps faults out of a quick run: scripts/lib/no-mutations.js (`quick`, `mutating`, `refusePlanting`), the refusal in `plantedPatch` and `plantedCopy` of scripts/lib/mutant-source.js (`patched` plants in a quick run too, because a head check rewrites a source as well), and the way scripts/check-all.js --quick sets it up for every script.

  node scripts/check-no-mutations.js [--no-mutations]

  A quick run plants no fault. A script that plants faults and never names `--no-mutations` is not told to skip them, so the guard makes it fail instead: check-all --quick sets CHECK_NO_MUTATIONS=1 for every script and the planting helpers (`refusePlanting`, `plantedPatch`, `plantedCopy`) throw when it is set. What the checks hold:
  - `quick` follows the flag and the variable (exactly `1`), and `mutating` is its opposite;
  - `refusePlanting`, `plantedPatch` and `plantedCopy` throw in a quick run, name what was planted, and plant outside one (the controls and the probes that plant run only when this script is not itself run quick, so that its own quick run plants nothing);
  - in a copy of check-all.js with three probe scripts, in a folder of its own, a probe that plants through `plantedPatch` and never names the flag fails check-all --quick with the refusal (and is neither given the flag nor stopped by it), and passes without --quick; a probe that names the flag is given it in a quick run, plants nothing and passes; a probe that plants nothing and does not name the flag is neither given the flag nor failed.

  Then each planted fault of the guard (a flag or a variable ignored, a refusal dropped, a variable never or always set, a flag never or always passed) must fail at least one check. --no-mutations leaves those out and runs the checks of the real sources alone.
*/
const fs = require('fs')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { inParallel, runChild } = require('./lib/check-pool')
const { plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')

const root = path.resolve(__dirname, '..')
const WORK = path.join(root, '.check-runs')
// Whether this run plants: the controls that plant outside a quick run (and the probes that do) run only when it does, so that a quick run of this script plants nothing either.
const FULL = mutating()
const MIRRORED = ['check-all.js', 'lib/check-pool.js', 'lib/no-mutations.js', 'lib/mutant-source.js']

// `#{` stands for a template expression in the text of a probe and of a fault, which a plain string cannot hold.
const dollars = (text) => text.replaceAll('#{', '$' + '{')
const source = (...lines) => dollars(lines.join('\n')) + '\n'

const PROBES = {
  'check-probe-ignoring.js': source(
    "const { plantedPatch } = require('./lib/mutant-source')",
    '',
    'try {',
    "  plantedPatch('probe.js', 'const value = 1', 'const value = 1', 'const value = 2')",
    "  console.log(`1 of 1 checks passed (planted 1, flag #{process.argv.includes('--' + 'no-mutations')}, env #{process.env.CHECK_NO_MUTATIONS || 'unset'})`)",
    '} catch (error) {',
    '  console.log(`FAIL #{error.message}`)',
    '  process.exitCode = 1',
    '}'
  ),
  'check-probe-honouring.js': source(
    '// node scripts/check-probe-honouring.js [--no-mutations]',
    "const { plantedPatch } = require('./lib/mutant-source')",
    "const { mutating } = require('./lib/no-mutations')",
    '',
    "const planted = mutating() ? plantedPatch('probe.js', 'const value = 1', 'const value = 1', 'const value = 2').length : 0",
    '',
    "console.log(`1 of 1 checks passed (planted #{planted ? 1 : 0}, flag #{process.argv.includes('--no-mutations')}, env #{process.env.CHECK_NO_MUTATIONS || 'unset'})`)"
  ),
  'check-probe-clean.js': source(
    'if (process.argv.length > 2) {',
    '  console.error(`Unknown argument: #{process.argv[2]}`)',
    '  process.exit(2)',
    '}',
    '',
    "console.log(`1 of 1 checks passed (planted 0, flag false, env #{process.env.CHECK_NO_MUTATIONS || 'unset'})`)"
  ),
}

// A folder of its own under .check-runs (where `acorn`, which `patched` needs, resolves from the repository) holding the files of the guard and the probe scripts, with each fault of `faults` ([file, find, replace]) planted in its file.
const mirror = (faults = []) => {
  fs.mkdirSync(WORK, { recursive: true })

  const folder = fs.mkdtempSync(path.join(WORK, 'no-mutations-'))

  fs.mkdirSync(path.join(folder, 'scripts', 'lib'), { recursive: true })

  for (const file of MIRRORED) {
    const text = faults.filter(([name]) => name === file).reduce((source, [, find, replace]) => plantedPatch(file, source, find, replace), fs.readFileSync(path.join(__dirname, file), 'utf8'))

    fs.writeFileSync(path.join(folder, 'scripts', file), text)
  }

  for (const [name, text] of Object.entries(PROBES)) {
    fs.writeFileSync(path.join(folder, 'scripts', name), text)
  }

  return folder
}

// `work` with the arguments and the variable of a run that is quick or not: `flag` puts --no-mutations on the command line, `env` is the value of CHECK_NO_MUTATIONS (unset when undefined). Both are put back after.
const under = ({ flag = false, env }, work) => {
  const argv = process.argv
  const held = process.env.CHECK_NO_MUTATIONS
  const set = (value) => (value === undefined ? delete process.env.CHECK_NO_MUTATIONS : (process.env.CHECK_NO_MUTATIONS = value))

  process.argv = flag ? [...argv.filter((argument) => argument !== '--no-mutations'), '--no-mutations'] : argv.filter((argument) => argument !== '--no-mutations')
  set(env)

  try {
    return work()
  } finally {
    process.argv = argv
    set(held)
  }
}

const QUICK = [{ flag: true }, { env: '1' }, { flag: true, env: '1' }]
const SLOW = [{}, { env: '' }, { env: '0' }, { env: 'true' }, { env: 'yes' }]

// The checks of the two libraries, loaded from `directory` (the real ones, or the copies a fault is planted in).
const libraryChecks = (directory) => {
  const { quick, mutating: asked, refusePlanting } = require(path.join(directory, 'no-mutations.js'))
  const { patched: rewrite, plantedPatch: plant, plantedCopy: plantCopy } = require(path.join(directory, 'mutant-source.js'))
  const temporary = path.join(directory, '..', '..', 'subject')

  fs.mkdirSync(temporary)
  fs.writeFileSync(path.join(temporary, 'subject.js'), 'const value = 1\n')

  return [
    ['quick follows the flag and the variable, and mutating is its opposite', () => {
      for (const state of QUICK) {
        under(state, () => {
          assert.equal(quick(), true, JSON.stringify(state))
          assert.equal(asked(), false, JSON.stringify(state))
        })
      }

      for (const state of SLOW) {
        under(state, () => {
          assert.equal(quick(), false, JSON.stringify(state))
          assert.equal(asked(), true, JSON.stringify(state))
        })
      }
    }],
    ['refusePlanting throws in a quick run and names what was planted, and does not outside one', () => {
      for (const state of QUICK) {
        under(state, () => assert.throws(() => refusePlanting('the thing planted'), /quick run.*the thing planted/))
      }

      for (const state of SLOW) {
        under(state, () => refusePlanting('the thing planted'))
      }
    }],
    ['plantedPatch throws in a quick run and names the fault, and plants outside one (a full run of this script); patched plants in both', () => {
      for (const state of QUICK) {
        under(state, () => {
          assert.throws(() => plant('subject.js', 'const value = 1\n', '1', '2'), /quick run.*subject\.js/)
          assert.equal(rewrite('subject.js', 'const value = 1\n', '1', '2'), 'const value = 2\n')
        })
      }

      for (const state of FULL ? SLOW : []) {
        under(state, () => assert.equal(plant('subject.js', 'const value = 1\n', '1', '2'), 'const value = 2\n'))
      }
    }],
    ['plantedCopy throws in a quick run and names the fault, and copies outside one (a full run of this script)', () => {
      for (const state of QUICK) {
        under(state, () => assert.throws(() => plantCopy(temporary, 'ae-no-mutations-copy-', 'subject.js', '1', '2'), /quick run.*subject\.js/))
      }

      for (const state of FULL ? SLOW : []) {
        under(state, () => {
          const copy = plantCopy(temporary, 'ae-no-mutations-copy-', 'subject.js', '1', '2')

          try {
            assert.equal(fs.readFileSync(path.join(copy, 'subject.js'), 'utf8'), 'const value = 2\n')
          } finally {
            fs.rmSync(copy, { recursive: true, force: true })
          }
        })
      }
    }],
  ]
}

const checkAll = (directory, args) => runChild(path.join(directory, 'scripts', 'check-all.js'), ['--jobs=1', '--scripts=1', ...args], { env: { CHECK_NO_MUTATIONS: '' }, limit: 120000 })

const outputOf = ({ stdout, stderr }) => `${stdout}\n${stderr}`

// The checks of the copy of check-all.js in `directory`, which runs the probe scripts beside it.
const allChecks = (directory) => [
  ['a script that plants through plantedPatch and never names the flag fails check-all --quick with the refusal', async () => {
    const result = await checkAll(directory, ['--quick', '--only=probe-ignoring'])

    assert.equal(result.code, 1, outputOf(result))
    assert.match(outputOf(result), /a fault is planted in a quick run/)
    assert.doesNotMatch(outputOf(result), /Unknown argument/)
  }],
  ['the same script passes check-all without --quick, with the variable unset', async () => {
    const result = await checkAll(directory, ['--only=probe-ignoring'])

    assert.equal(result.code, 0, outputOf(result))
    assert.match(outputOf(result), /planted 1, flag false, env unset/)
  }, true],
  ['a script that names the flag is given it by check-all --quick, plants nothing and passes', async () => {
    const result = await checkAll(directory, ['--quick', '--only=probe-honouring'])

    assert.equal(result.code, 0, outputOf(result))
    assert.match(outputOf(result), /planted 0, flag true, env 1/)
  }],
  ['the same script is given neither the flag nor the variable without --quick and plants', async () => {
    const result = await checkAll(directory, ['--only=probe-honouring'])

    assert.equal(result.code, 0, outputOf(result))
    assert.match(outputOf(result), /planted 1, flag false, env unset/)
  }, true],
  ['a script that plants nothing and does not name the flag is given the variable and not the flag, and passes', async () => {
    const result = await checkAll(directory, ['--quick', '--only=probe-clean'])

    assert.equal(result.code, 0, outputOf(result))
    assert.match(outputOf(result), /planted 0, flag false, env 1/)
  }],
].filter(([, , planting]) => FULL || !planting)

const NO_MUTATIONS = 'lib/no-mutations.js'
const MUTANT_SOURCE = 'lib/mutant-source.js'

// [label, the files and the changes that plant it ([file, find, replace]), which checks must fail it: 'library' or 'all']
const FAULTS = [
  ['quick ignores the flag', [[NO_MUTATIONS, "process.argv.includes('--no-mutations') || ", '']], 'library'],
  ['quick ignores the variable', [[NO_MUTATIONS, " || process.env.CHECK_NO_MUTATIONS === '1'", '']], 'library'],
  ['quick takes any value of the variable', [[NO_MUTATIONS, "process.env.CHECK_NO_MUTATIONS === '1'", 'process.env.CHECK_NO_MUTATIONS !== undefined']], 'library'],
  ['mutating is always true', [[NO_MUTATIONS, 'const mutating = () => !quick()', 'const mutating = () => true']], 'library'],
  ['refusePlanting never throws', [[NO_MUTATIONS, 'if (quick()) {\n    throw', 'if (false) {\n    throw']], 'library'],
  ['refusePlanting does not name what was planted', [[NO_MUTATIONS, dollars(': #{what}. A script'), '. A script']], 'library'],
  ['plantedPatch does not refuse a planting', [[MUTANT_SOURCE, dollars('refusePlanting(`#{file}: #{from}`)\n\n  return patched'), 'return patched']], 'library'],
  ['patched refuses in a quick run', [[MUTANT_SOURCE, 'const patched = (file, text, from, to) => {\n', dollars('const patched = (file, text, from, to) => {\n  refusePlanting(`#{file}: #{from}`)\n')]], 'library'],
  ['plantedPatch does not plant', [[MUTANT_SOURCE, 'return patched(file, text, from, to)\n}\n\n// A temporary', 'return text\n}\n\n// A temporary']], 'library'],
  ['plantedCopy does not refuse a planting', [[MUTANT_SOURCE, dollars('refusePlanting(`#{file}: #{from}`)\n\n  const result'), 'const result']], 'library'],
  ['check-all sets no variable', [['check-all.js', "...(quick ? { CHECK_NO_MUTATIONS: '1' } : {})", '...{}']], 'all'],
  ['check-all sets the variable in a full run too', [['check-all.js', "...(quick ? { CHECK_NO_MUTATIONS: '1' } : {})", "CHECK_NO_MUTATIONS: '1'"]], 'all'],
  ['check-all never passes the flag', [['check-all.js', "quick && source.includes('--no-mutations') ? ['--no-mutations'] : []", '[]']], 'all'],
  ['check-all passes the flag to every script', [['check-all.js', "quick && source.includes('--no-mutations') ? ['--no-mutations'] : []", "quick ? ['--no-mutations'] : []"]], 'all'],
]

// The checks of a guard made of `faults` (none: the real one) as [[name, true or the reason it failed]]; `kinds` are the groups to run.
const judged = async (faults, kinds) => {
  const folder = mirror(faults)
  const results = []

  try {
    const groups = { library: () => libraryChecks(path.join(folder, 'scripts', 'lib')), all: () => allChecks(folder) }

    for (const kind of kinds) {
      for (const [name, test] of groups[kind]()) {
        try {
          await test()
          results.push([name, true])
        } catch (error) {
          results.push([name, String(error.message).split('\n')[0].slice(0, 300)])
        }
      }
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }

  return results
}

// The steps check-typography.js schedules (its --schedule opens no browser and plants nothing), in the quick states of the flag and of the variable and in a full one: the fixtures that make the page throw are scheduled only outside a quick run, and the real ones always.
const FAULT_STEPS = ['/about render fixture', '/about foreign-error fixture', '/about palette-error fixture', '/about foreign-palette-error fixture']
const HEAD_STEPS = ['/about pointer and keyboard fixtures', '/about real-page reader fixture', '/warnings known-exception fixture']

const scheduleChecks = () => {
  const scheduled = async (args, env) => {
    const result = await runChild(path.join(__dirname, 'check-typography.js'), ['--schedule', ...args], { env: { CHECK_NO_MUTATIONS: env, VIEWPORTS: '1280x720' }, limit: 60000 })

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)

    return result.stdout
  }
  const hasStep = (output, name) => output.split('\n').some((line) => line.endsWith(` ${name}`))

  return [
    ['a quick run of check-typography (the flag, the variable) schedules the real fixtures and none that makes the page throw, and a full run schedules both', async () => {
      for (const [args, env] of [[['--no-mutations'], ''], [[], '1'], [['--no-mutations'], '1']]) {
        const output = await scheduled(args, env)

        HEAD_STEPS.forEach((name) => assert.ok(hasStep(output, name), `${name} is not scheduled in a quick run (${args}, ${env})`))
        FAULT_STEPS.forEach((name) => assert.ok(!hasStep(output, name), `${name} is scheduled in a quick run (${args}, ${env})`))
      }

      const output = await scheduled([], '')

      ;[...HEAD_STEPS, ...FAULT_STEPS].forEach((name) => assert.ok(hasStep(output, name), `${name} is not scheduled in a full run`))
    }],
  ]
}

const run = async () => {
  let checks = 0
  let failures = 0
  const tally = (ok) => {
    checks++

    if (!ok) {
      failures++
    }
  }

  const planted = mutating() ? inParallel(FAULTS, ([, faults, kind]) => judged(faults, [kind])) : null

  console.log('The guard of quick runs')

  for (const [name, result] of await judged([], ['library', 'all'])) {
    tally(result === true)
    console.log(`${result === true ? 'PASS' : 'FAIL'}  ${name}${result === true ? '' : `  [${result}]`}`)
  }

  for (const [name, test] of scheduleChecks()) {
    try {
      await test()
      tally(true)
      console.log(`PASS  ${name}`)
    } catch (error) {
      tally(false)
      console.log(`FAIL  ${name}  [${String(error.message).split('\\n')[0].slice(0, 300)}]`)
    }
  }

  if (planted) {
    console.log('\nMutations: each must fail at least one check')

    const outcomes = await planted

    for (const [index, [label]] of FAULTS.entries()) {
      const outcome = outcomes[index]

      if (outcome instanceof Error) {
        tally(false)
        console.log(`FAIL  mutation caught: ${label}  [${outcome.message}]`)
        continue
      }

      const failed = outcome.filter(([, result]) => result !== true)

      tally(failed.length > 0)
      console.log(`${failed.length ? 'PASS' : 'FAIL'}  mutation caught: ${label}  [${failed.length ? `${failed.length} of ${outcome.length} checks fail` : 'every check still passes'}]`)
    }
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exit(failures ? 1 : 0)
}

run().catch((error) => {
  console.error(error)
  process.exit(2)
})
