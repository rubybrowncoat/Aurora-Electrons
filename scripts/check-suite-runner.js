/*
  Checks scripts/lib/suite-runner.js, the runner the long check suites run their heads and variants through, on a suite made for it (scripts/lib/suite-runner-fixture.js) whose variants pass, fail, hang, spin, crash, throw and end late.

  Run: bun scripts/check-suite-runner.js [--no-mutations]

  Each scenario copies the runner, scripts/lib/check-pool.js, scripts/lib/browser-observe.js and the suite into a layout of its own under the temp folder (a file of its own under `src` stands for the tree, saves/input.db for the suite's inputs), runs the suite there (scripts/lib/check-pool.js `startChild`, ended at its limit of 45 s whatever it does) and reads what it printed, the record it left and the ledger in which each variant noted the process it ran in:
  - `all`: the variants print in the order of the list whatever ends when; a variant that hangs or spins past its deadline, and one whose worker ends, fails by name as a defect of the harness and the run goes on in a fresh worker; an error a variant throws fails it by name and its worker goes on; the totals count each once and the run ends with status 2; the control (the fault, then the head, in one worker) passes;
  - `leaky`: the same suite whose reset leaves the fault's state behind: the control fails;
  - `control`: a control whose own reset fails is failed, never credited;
  - `late`: in a layout whose copy of check-pool waits 1.5 s before it ends a process, as a loaded machine's taskkill can, a variant that ends half a second after its deadline, while its worker is being ended, still fails by name;
  - `closing`: a worker whose reset fails ends, its close (10 s) is ended at the `between` deadline (4 s), which the setup deadline (15 s) would not end, and named as a defect of the run, as the close of the worker, the variant after it runs in a fresh worker, and a resumed run reports the defect again;
  - `interrupted`: a run stopped while its last worker closes (a close that fails after 2 s) has not written that worker's last variant, so the resumed run runs it again and reports the close that fails;
  - `tornClose`: a whole run whose last worker's close fails, with the last line of its record cut in half, is resumed with that worker's last variant run again and its close reported, never green;
  - `deaths`: a worker that finishes a variant before it ends starts the count again; after three workers in a row end without finishing one, the rest of the queue fails by name and is never started;
  - `setup`: a setup that fails fails every variant of the queue by name, by the error it threw, none started;
  - `setupClose`: a setup that fails, whose close (10 s) is ended at the `between` deadline (4 s), which the setup deadline (15 s) would not end: every variant of the queue fails by the error of the setup and by the deadline of the close, with no step the setup said;
  - `resume`: a run ended in the middle of a variant and resumed runs only the variants not recorded, and its totals are those of a whole run; a whole record resumed again runs nothing; a record whose last line was cut in half is resumed, and resumed again, without running a variant twice; a record is not resumed with another list of variants, once its save changed (to bytes of the same length, its time of last write put back), nor once a file of the tree changed;
  - `steps`: variants that say their steps (`step` of the runner, and `observe` of browser-observe for the steps of its work) and stall: a deadline names the last step its variant said, its own or its observation's, the step of the observation still open when another beside it has ended, and none for a variant that said none after a setup that said one, nor for a close (10 s, ended at 4 s) after a variant that said one; no step reaches the output, nor one said outside a worker;
  - `repeated`: `--variants` that names a key again runs it again, each run a variant of its own (`pass#2`) counted once, in one worker, whose setup and reset are handed the variant the suite defined; resumed with only the last repeat left (its line of the record torn), the run runs that repeat alone, on a setup handed the variant of its key;
  - `prepared`: a setup that waits for a child (4.5 s, under the limit of 8 s that check-pool's `startChild` puts on it), longer than a variant's deadline (3 s) and within the setup's (15 s), as the setup of scripts/check-specialist-deployments.js waits for the cases it reads in children: a variant that comes first in a fresh worker (`--variants`) or in a resumed run passes, the same wait in the first variant instead fails it by name, and a child past its limit is ended and said to be;
  - `racing`: in a layout whose copy of check-pool waits 4 s before it ends a process, the setup's child, with a limit of 2 s, ends well at 3 s while it is being ended: it reads as a child that did not finish, never as one that succeeded.
  Each planted fault rewrites one line of the copy of the runner (or of browser-observe or check-pool) and must make a named check fail; each benign rewrite must make none of the checks of the scenarios it touches fail.

  Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { startChild } = require('./lib/check-pool')
const { patched } = require('./lib/mutant-source')

const LIB = path.join(__dirname, 'lib')
const RUNNER = 'scripts/lib/suite-runner.js'
const OBSERVER = 'scripts/lib/browser-observe.js'
const POOL = 'scripts/lib/check-pool.js'
const FIXTURE = 'suite-runner-fixture.js'
const LIMIT = 45000
// The scenarios whose layout ends a process that long (ms) after it is asked to.
const KILL_DELAYS = { late: 1500, racing: 4000 }

// A layout of its own: the runner, browser-observe and check-pool as given in `sources` (by RUNNER, OBSERVER and POOL; check-pool slow to end a process by `killDelay` ms) and the suite, a file of the tree and the suite's save.
const layoutOf = (sources, killDelay) => {
  const layout = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-suite-runner-'))
  const lib = path.join(layout, 'scripts', 'lib')

  fs.mkdirSync(lib, { recursive: true })
  fs.mkdirSync(path.join(layout, 'src'))
  fs.mkdirSync(path.join(layout, 'saves'))
  fs.writeFileSync(path.join(layout, 'src', 'one.js'), 'module.exports = 1\n')
  fs.writeFileSync(path.join(layout, 'saves', 'input.db'), 'a save\n')
  fs.writeFileSync(path.join(lib, 'suite-runner.js'), sources[RUNNER])
  fs.writeFileSync(path.join(lib, 'browser-observe.js'), sources[OBSERVER])
  fs.writeFileSync(path.join(lib, 'check-pool.js'), killDelay ? patched(POOL, sources[POOL], 'const killTree = (pid) => {', `const killTree = (pid) => {\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${killDelay})`) : sources[POOL])
  fs.copyFileSync(path.join(LIB, FIXTURE), path.join(lib, FIXTURE))

  return layout
}

// One run of the suite in `layout`: { code, stdout, stderr, timedOut }. `stopOn` ends the run and everything it started once a line it matches is printed, as a run is ended in the middle.
const runIn = (layout, args, { env = {}, stopOn = null } = {}) => {
  let stopping = stopOn
  const handle = startChild(path.join(layout, 'scripts', 'lib', FIXTURE), args, {
    env,
    limit: LIMIT,
    onLine: (line) => {
      if (stopping && stopping.test(line)) {
        stopping = null
        handle.kill()
      }
    },
  })

  return handle.done.catch((error) => ({ code: null, stdout: '', stderr: String(error.message), timedOut: false }))
}

// The ledger of the layout: [key, pid] for each variant started, in the order they started.
const ledgerOf = (layout) => {
  const file = path.join(layout, 'ledger.txt')

  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => line.split(' ')) : []
}

// The file of the record of the layout's run.
const recordFileOf = (layout) => {
  const folder = path.join(layout, '.check-runs', 'suite-runner-fixture')
  const files = fs.existsSync(folder) ? fs.readdirSync(folder) : []

  return files.length === 1 ? path.join(folder, files[0]) : null
}

// The variants the record of the layout holds, by key.
const recordOf = (layout) => {
  const file = recordFileOf(layout)

  return file ? Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(1).map((line) => JSON.parse(line)).filter((entry) => entry.key).map((result) => [result.key, result])) : {}
}

// The last line of the record cut in half, its line break with it, as a run stopped while it wrote the line leaves it.
const tear = (layout) => {
  const file = recordFileOf(layout)
  const text = fs.readFileSync(file, 'utf8')
  const start = text.slice(0, -1).lastIndexOf('\n') + 1

  fs.writeFileSync(file, text.slice(0, start + Math.floor((text.length - start) / 2)))
}

const inLayout = async (sources, need) => {
  const layout = layoutOf(sources, KILL_DELAYS[need] || 0)

  try {
    return await SCENARIOS[need](layout)
  } catch (error) {
    return { error: String(error.message).split('\n')[0] }
  } finally {
    fs.rmSync(layout, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

const RESUME = ['--set=resume', '--resume']
const REPEAT = ['--set=all', '--variants=pass,fail,pass,pass']
const CLOSING = { FAKE_RESET_FAIL: 'x1', FAKE_CLOSE_SLOW: 'x1', FAKE_BETWEEN: '4' }
const PREPARED = ['--set=prepared']
// The setup's child: 4.5 s, past a variant's deadline (3 s) and within its limit (8 s) and the setup's deadline (15 s).
const CHILD = { FAKE_CHILD: '4500' }

const SCENARIOS = {
  all: (layout) => runIn(layout, ['--set=all']).then((run) => ({ ...run, ledger: ledgerOf(layout), record: recordOf(layout) })),
  leaky: (layout) => runIn(layout, ['--set=all'], { env: { FAKE_LEAKY: '1' } }),
  control: (layout) => runIn(layout, ['--set=control'], { env: { FAKE_RESET_FAIL: 'control:warm-reset' } }),
  late: (layout) => runIn(layout, ['--set=late']).then((run) => ({ ...run, record: recordOf(layout) })),
  closing: async (layout) => {
    const first = await runIn(layout, ['--set=closing'], { env: CLOSING })
    const resumed = await runIn(layout, ['--set=closing', '--resume'], { env: CLOSING })

    return { first, resumed }
  },
  deaths: (layout) => runIn(layout, ['--set=deaths']).then((run) => ({ ...run, ledger: ledgerOf(layout) })),
  interrupted: async (layout) => {
    const stopped = await runIn(layout, ['--set=closing'], { env: { FAKE_CLOSE_FAIL: '1' }, stopOn: /^PASS {2}x1$/ })
    const resumed = await runIn(layout, ['--set=closing', '--resume'], { env: { FAKE_CLOSE_FAIL: '1' } })

    return { stopped, resumed, ledger: ledgerOf(layout) }
  },
  tornClose: async (layout) => {
    const first = await runIn(layout, ['--set=closing'], { env: { FAKE_CLOSE_FAIL: '1' } })

    tear(layout)

    const resumed = await runIn(layout, ['--set=closing', '--resume'], { env: { FAKE_CLOSE_FAIL: '1' } })

    return { first, resumed }
  },
  setup: (layout) => runIn(layout, ['--set=resume'], { env: { FAKE_SETUP_FAIL: '1' } }).then((run) => ({ ...run, ledger: ledgerOf(layout) })),
  setupClose: (layout) => runIn(layout, ['--set=closing'], { env: { FAKE_SETUP_FAIL: '1', FAKE_CLOSE_SLOW: 'x1', FAKE_BETWEEN: '4' } }).then((run) => ({ ...run, ledger: ledgerOf(layout) })),
  resume: async (layout) => {
    const stopped = await runIn(layout, ['--set=resume'], { stopOn: /^PASS {2}r3$/ })
    const resumed = await runIn(layout, RESUME)
    const ledgers = { resumed: ledgerOf(layout) }
    const again = await runIn(layout, RESUME)

    tear(layout)

    const torn = await runIn(layout, RESUME)
    const tornAgain = await runIn(layout, RESUME)

    ledgers.torn = ledgerOf(layout)

    const listed = await runIn(layout, RESUME, { env: { FAKE_EXTRA: '1' } })

    const save = path.join(layout, 'saves', 'input.db')
    const written = fs.statSync(save)

    fs.writeFileSync(save, 'b save\n')
    fs.utimesSync(save, written.atime, written.mtime)

    const saved = await runIn(layout, RESUME)

    fs.writeFileSync(path.join(layout, 'src', 'one.js'), 'module.exports = 2\n')

    const changed = await runIn(layout, RESUME)

    return { stopped, resumed, again, torn, tornAgain, listed, saved, changed, ledgers }
  },
  steps: (layout) => runIn(layout, ['--set=steps'], { env: { FAKE_CLOSE_SLOW: 'closed', FAKE_BETWEEN: '4' } }),
  repeated: async (layout) => {
    const run = await runIn(layout, REPEAT)
    const record = recordOf(layout)
    const ledger = ledgerOf(layout)

    tear(layout)

    const resumed = await runIn(layout, [...REPEAT, '--resume'])

    return { ...run, record, ledger, resumed, resumedLedger: ledgerOf(layout).slice(ledger.length) }
  },
  prepared: async (layout) => {
    const whole = await runIn(layout, PREPARED, { env: CHILD })
    const ledger = ledgerOf(layout)

    tear(layout)

    const resumed = await runIn(layout, [...PREPARED, '--resume'], { env: CHILD })
    const resumedLedger = ledgerOf(layout).slice(ledger.length)
    const first = await runIn(layout, [...PREPARED, '--variants=p2'], { env: CHILD })
    const lazy = await runIn(layout, [...PREPARED, '--variants=p2'], { env: { ...CHILD, FAKE_LAZY: '1' } })
    const limited = await runIn(layout, [...PREPARED, '--variants=p1'], { env: { FAKE_CHILD: '60000' } })

    return { whole, resumed, resumedLedger, first, lazy, limited }
  },
  racing: (layout) => runIn(layout, [...PREPARED, '--variants=p1'], { env: { FAKE_CHILD: '3000', FAKE_LIMIT: '2000' } }),
}

const observe = async (sources, needs) => {
  const seen = {}

  for (const need of needs) {
    seen[need] = await inLayout(sources, need)
  }

  return seen
}

// What a run printed: the key of each PASS or FAIL line (the control's `control:`), the totals and the defects of the harness.
const printed = (stdout) => stdout.split('\n').map((line) => /^(?:PASS|FAIL) {2}(?:variant )?(\S+)/.exec(line)).filter(Boolean).map((match) => match[1])
const totalsOf = (stdout) => (/(\d+ of \d+) checks passed/.exec(stdout) || [])[1] || null
const harnessOf = (stdout) => JSON.parse((/^HARNESS (.*)$/m.exec(stdout) || [null, '[]'])[1])
const pidOf = (ledger, key) => (ledger.find(([name]) => name === key) || [])[1] || null
const countOf = (ledger, key) => ledger.filter(([name]) => name === key).length
const ran = (run, what) => {
  assert.ok(run && !run.error, run && run.error)
  assert.equal(run.timedOut, false, `${what} did not end in ${LIMIT / 1000} s`)
}
const harnessHas = (run, key, start) => assert.ok(harnessOf(run.stdout).some((line) => line.startsWith(`${key}: ${start}`)), `no defect of the harness ${key}: ${start}… in ${JSON.stringify(harnessOf(run.stdout))}`)
const problemOf = (run, start) => assert.ok(harnessOf(run.stdout).some((line) => line.startsWith(start)), `no defect of the run ${start}… in ${JSON.stringify(harnessOf(run.stdout))}`)
const harnessIs = (run, line) => assert.ok(harnessOf(run.stdout).includes(line), `no defect of the harness "${line}" in ${JSON.stringify(harnessOf(run.stdout))}`)
// The line of stderr that says why a run would not resume: its message, not a line of the source the runtime prints around the throw (which can hold the message of another refusal).
const refusalOf = (run) => run.stderr.split('\n').find((line) => line.includes('--resume: ') && !/^\s*\d+\s*\|/.test(line)) || ''

// [id, scenarios it needs, what it holds, the assertions over what they saw]
const CHECKS = [
  ['order', ['all'], 'the variants print in the order of the list, the control last, whatever ends when', ({ all }) => {
    ran(all, 'the suite')
    assert.deepStrictEqual(printed(all.stdout), ['head', 'pass', 'fail', 'hang', 'after-hang', 'spin', 'after-spin', 'throw', 'after-throw', 'crash', 'after-crash', 'fault', 'control:'])
  }],
  ['totals', ['all'], 'the totals count every variant once, each defect of the harness as a failed check that is never credited, and the run ends with status 2', ({ all }) => {
    ran(all, 'the suite')
    assert.equal(totalsOf(all.stdout), '8 of 13')
    assert.equal(all.code, 2)
  }],
  ['deadline', ['all'], 'a variant that hangs or spins past its deadline fails by name as a defect of the harness once the deadline has passed, and the run goes on in a fresh worker', ({ all }) => {
    ran(all, 'the suite')

    for (const key of ['hang', 'spin']) {
      harnessHas(all, key, `the variant ${key} did not finish in 3 s`)
      assert.ok(all.record[key] && all.record[key].seconds >= 3 && all.record[key].seconds < 10, `${key} ended after ${all.record[key] && all.record[key].seconds} s`)
      assert.notEqual(pidOf(all.ledger, `after-${key}`), pidOf(all.ledger, key), `the variant after ${key} ran in a fresh worker`)
    }
  }],
  ['thrown', ['all'], 'an error a variant throws fails it by name as a defect of the harness, and its worker goes on with the next', ({ all }) => {
    ran(all, 'the suite')
    harnessHas(all, 'throw', 'a defect of the harness planted')
    assert.equal(pidOf(all.ledger, 'after-throw'), pidOf(all.ledger, 'throw'))
  }],
  ['crash', ['all'], 'a worker that ends in the middle of a variant fails that variant by name, and the next runs in a fresh worker', ({ all }) => {
    ran(all, 'the suite')
    harnessHas(all, 'crash', 'the worker ended with status 9')
    assert.notEqual(pidOf(all.ledger, 'after-crash'), pidOf(all.ledger, 'crash'))
  }],
  ['control', ['all'], 'the control runs the fault and then the head in one worker, and passes when the reset puts the state back', ({ all }) => {
    ran(all, 'the suite')
    assert.ok(/^PASS {2}control: .*the fault caught, then the head 1 of 1/m.test(all.stdout), 'the control passed')
  }],
  ['control-leak', ['leaky'], 'the control fails when the reset leaves the state of the fault behind', ({ leaky }) => {
    ran(leaky, 'the leaky suite')
    assert.ok(/^FAIL {2}control: /m.test(leaky.stdout), 'the control failed')
  }],
  ['control-reset', ['control'], 'a control whose own reset fails is failed as a defect of the harness, never credited', ({ control }) => {
    ran(control, 'the suite whose reset after the control fails')
    harnessHas(control, 'control:warm-reset', 'after the variant: a reset planted to fail')
    assert.equal(totalsOf(control.stdout), '2 of 3')
    assert.equal(control.code, 2)
  }],
  ['late', ['late'], 'a variant that ends after its deadline has passed, while its worker is being ended, fails by name as a defect of the harness: nothing the worker says after the deadline is heard', ({ late }) => {
    ran(late, 'the late suite')
    harnessHas(late, 'late', 'the variant late did not finish in 1 s')
    assert.ok(late.record.late && late.record.late.failures === 1, 'late is recorded failed')
    assert.deepStrictEqual(printed(late.stdout), ['late', 'after-late'])
    assert.equal(totalsOf(late.stdout), '1 of 2')
    assert.equal(late.code, 2)
  }],
  ['closing', ['closing'], 'a worker whose reset fails ends, and its close is bounded by the `between` deadline from the moment it begins, not the longer setup deadline: past it the worker is ended and named as a defect of the run, as its close, and the variant after it runs in a fresh worker', ({ closing }) => {
    ran(closing.first, 'the suite whose reset fails')
    harnessHas(closing.first, 'x1', 'after the variant: a reset planted to fail')
    problemOf(closing.first, 'a worker ended badly after the variant x1: the close of the worker did not finish in 4 s')
    assert.ok(/^PASS {2}x2$/m.test(closing.first.stdout), 'x2 passed')
    assert.equal(totalsOf(closing.first.stdout), '2 of 3')
    assert.equal(closing.first.code, 2)
  }],
  ['closing-resume', ['closing'], 'a defect of a worker is kept in the record: a resumed run reports it again and ends with status 2', ({ closing }) => {
    ran(closing.resumed, 'the resumed run')
    assert.ok(/resumed: 2 of 2 variants done/.test(closing.resumed.stdout), closing.resumed.stdout.split('\n')[0])
    problemOf(closing.resumed, 'a worker ended badly after the variant x1')
    assert.equal(closing.resumed.code, 2)
  }],
  ['closing-stopped', ['interrupted'], 'a run stopped while its last worker closes has not written that worker\'s last variant: resumed, it runs that variant again and reports the close that fails', ({ interrupted }) => {
    ran(interrupted.resumed, 'the resumed run')
    assert.ok(interrupted.stopped.code !== 0, 'the first run was ended')
    assert.ok(/resumed: 1 of 2 variants done/.test(interrupted.resumed.stdout), interrupted.resumed.stdout.split('\n')[0])
    assert.equal(countOf(interrupted.ledger, 'x2'), 2, 'x2 ran again')
    problemOf(interrupted.resumed, 'a worker ended badly after the variant x2: the worker ended with status 3')
    assert.equal(interrupted.resumed.code, 2)
  }],
  ['closing-torn', ['tornClose'], 'a record whose last line, the last variant of a worker whose close failed, was cut in half is resumed with that variant run again and the close reported, never green', ({ tornClose }) => {
    ran(tornClose.resumed, 'the resumed run')
    assert.equal(tornClose.first.code, 2, 'the whole run reported the close')
    assert.ok(/resumed: 1 of 2 variants done/.test(tornClose.resumed.stdout), tornClose.resumed.stdout.split('\n')[0])
    problemOf(tornClose.resumed, 'a worker ended badly after the variant x2: the worker ended with status 3')
    assert.equal(tornClose.resumed.code, 2)
  }],
  ['deaths', ['deaths'], 'a worker that finished a variant before it ended starts the count again: after three workers in a row end without finishing one, the rest of the queue fails by name without being started', ({ deaths }) => {
    ran(deaths, 'the dying suite')
    assert.equal(pidOf(deaths.ledger, 'c1'), pidOf(deaths.ledger, 'ok'), 'ok and c1 ran in one worker')

    for (const key of ['c1', 'c2', 'c3', 'c4']) {
      harnessHas(deaths, key, 'the worker ended with status 9')
    }

    harnessHas(deaths, 'd5', 'not run: 3 workers in a row ended')
    assert.equal(countOf(deaths.ledger, 'd5'), 0, 'd5 was never started')
  }],
  ['setup', ['setup'], 'a setup that fails fails every variant of its queue by name, by the error it threw, none started, and the run ends with status 2', ({ setup }) => {
    ran(setup, 'the suite whose setup fails')

    for (const key of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) {
      harnessIs(setup, `${key}: not run: the setup failed: a setup planted to fail`)
    }

    assert.equal(setup.ledger.length, 0)
    assert.equal(setup.code, 2)
  }],
  ['setup-close', ['setupClose'], 'the close after a setup that failed is bounded by the `between` deadline, not the longer setup deadline: past it every variant of the queue fails by the error of the setup and by the deadline of the close, with no step the setup said, none started, and the run ends with status 2', ({ setupClose }) => {
    ran(setupClose, 'the suite whose setup fails and whose close is slow')

    for (const key of ['x1', 'x2']) {
      harnessIs(setupClose, `${key}: not run: the setup failed: a setup planted to fail; the close of the worker did not finish in 4 s`)
    }

    assert.equal(setupClose.ledger.length, 0)
    assert.equal(setupClose.code, 2)
  }],
  ['resume-skips', ['resume'], 'a run ended in the middle of a variant and resumed runs only the variants not recorded, prints every variant in order, and its totals are those of a whole run', ({ resume }) => {
    ran(resume.resumed, 'the resumed run')
    assert.ok(resume.stopped.code !== 0, 'the first run was ended')
    assert.ok(/resumed: 3 of 6 variants done/.test(resume.resumed.stdout), resume.resumed.stdout.split('\n')[0])
    assert.deepStrictEqual(printed(resume.resumed.stdout), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'])
    assert.equal(totalsOf(resume.resumed.stdout), '6 of 6')
    assert.equal(resume.resumed.code, 0)
    assert.deepStrictEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((key) => countOf(resume.ledgers.resumed, key)), [1, 1, 1, 2, 1, 1], 'each variant started once in all, r4 again after the run was ended in it')
  }],
  ['resume-again', ['resume'], 'a whole record resumed again runs nothing and gives the same totals', ({ resume }) => {
    ran(resume.again, 'the run resumed again')
    assert.ok(/resumed: 6 of 6 variants done/.test(resume.again.stdout), resume.again.stdout.split('\n')[0])
    assert.equal(totalsOf(resume.again.stdout), '6 of 6')
    assert.equal(resume.again.code, 0)
  }],
  ['resume-torn', ['resume'], 'a record whose last line was cut in half is resumed with that variant run again, and resumed once more runs nothing', ({ resume }) => {
    ran(resume.torn, 'the run over the torn record')
    ran(resume.tornAgain, 'the run resumed once more')
    assert.ok(/resumed: 5 of 6 variants done/.test(resume.torn.stdout), resume.torn.stdout.split('\n')[0])
    assert.equal(totalsOf(resume.torn.stdout), '6 of 6')
    assert.ok(/resumed: 6 of 6 variants done/.test(resume.tornAgain.stdout), `${resume.tornAgain.stdout.split('\n')[0]} ${resume.tornAgain.stderr.slice(-300)}`)
    assert.equal(resume.tornAgain.code, 0)
    assert.equal(countOf(resume.ledgers.torn, 'r6'), 2, 'r6 ran once more, over the torn line, and not again')
  }],
  ['refuse-list', ['resume'], 'a record is not resumed with another list of variants', ({ resume }) => {
    ran(resume.listed, 'the run with another list')
    assert.notEqual(resume.listed.code, 0)
    assert.ok(/the list of variants changed/.test(refusalOf(resume.listed)), resume.listed.stderr.slice(-300))
  }],
  ['refuse-inputs', ['resume'], 'a record is not resumed once a save the suite reads changed', ({ resume }) => {
    ran(resume.saved, 'the run over a changed save')
    assert.notEqual(resume.saved.code, 0)
    assert.ok(/a save the suite reads changed/.test(refusalOf(resume.saved)), resume.saved.stderr.slice(-300))
  }],
  ['refuse-tree', ['resume'], 'a record is not resumed once a file of the tree changed', ({ resume }) => {
    ran(resume.changed, 'the run over a changed tree')
    assert.notEqual(resume.changed.code, 0)
    assert.ok(/the tree changed/.test(refusalOf(resume.changed)), resume.changed.stderr.slice(-300))
  }],
  ['step-named', ['steps'], 'a variant past its deadline is named with the last step it said, its own or one of the work of its observation, or the step of the observation still open when another beside it has ended, and the run goes on', ({ steps }) => {
    ran(steps, 'the suite whose variants say their steps')
    harnessIs(steps, 'stalled: the variant stalled did not finish in 3 s; the last step it reached: picking the game')
    harnessIs(steps, 'observed-stall: the variant observed-stall did not finish in 3 s; the last step it reached: reading the fake page')
    harnessIs(steps, 'parallel-stall: the variant parallel-stall did not finish in 3 s; the last step it reached: waiting for the stalled observation')
    assert.ok(/^PASS {2}after-stall$/m.test(steps.stdout), 'after-stall passed')
  }],
  ['step-reset', ['steps'], 'a deadline names only a step said since its variant began: none for a variant that said none after a setup that said one, none for a close after a variant that said one', ({ steps }) => {
    ran(steps, 'the suite whose variants say their steps')
    harnessIs(steps, 'quiet-stall: the variant quiet-stall did not finish in 3 s')
    harnessIs(steps, 'a worker ended badly after the variant closed: the close of the worker did not finish in 4 s')
  }],
  ['step-quiet', ['steps'], 'no step reaches the output, nor one said outside a worker: the variants print their own lines in order and the totals count each once', ({ steps }) => {
    ran(steps, 'the suite whose variants say their steps')
    assert.ok(!steps.stdout.includes('@@suite-runner'), steps.stdout.split('\n').find((line) => line.includes('@@suite-runner')))
    assert.deepStrictEqual(printed(steps.stdout), ['quiet-stall', 'stepped', 'stalled', 'after-stall', 'observed-stall', 'parallel-stall', 'closed'])
    assert.equal(totalsOf(steps.stdout), '3 of 7')
  }],
  ['repeat', ['repeated'], 'a key that --variants names again runs again in the same worker, each run a variant of its own that is printed and counted once, on a setup and a reset handed the variant the suite defined, also when a resumed run has only a repeat left', ({ repeated }) => {
    ran(repeated, 'the run that repeats a variant')
    assert.deepStrictEqual(printed(repeated.stdout), ['pass', 'fail', 'pass', 'pass'])
    assert.equal(totalsOf(repeated.stdout), '3 of 4')
    assert.deepStrictEqual(harnessOf(repeated.stdout), [])
    assert.deepStrictEqual(Object.keys(repeated.record).sort(), ['fail', 'pass', 'pass#2', 'pass#3'])
    assert.equal(countOf(repeated.ledger, 'pass'), 3)
    assert.equal(new Set(repeated.ledger.map(([, pid]) => pid)).size, 1, 'one worker ran them all')
    ran(repeated.resumed, 'the resumed run')
    assert.ok(/resumed: 3 of 4 variants done/.test(repeated.resumed.stdout), repeated.resumed.stdout.split('\n')[0])
    assert.deepStrictEqual(printed(repeated.resumed.stdout), ['pass', 'fail', 'pass', 'pass'])
    assert.equal(totalsOf(repeated.resumed.stdout), '3 of 4')
    assert.deepStrictEqual(harnessOf(repeated.resumed.stdout), [])
    assert.deepStrictEqual(repeated.resumedLedger.map(([key]) => key), ['pass'], 'the resumed run ran the last repeat alone')
  }],
  ['prepare-first', ['prepared'], 'a variant that comes first in a fresh worker (--variants) passes though its setup waited past the variant\'s deadline: what the setup waits for is bounded by the setup deadline, never by the first variant\'s', ({ prepared }) => {
    ran(prepared.first, 'the run of one variant')
    assert.deepStrictEqual(printed(prepared.first.stdout), ['p2'])
    assert.equal(totalsOf(prepared.first.stdout), '1 of 1')
    assert.deepStrictEqual(harnessOf(prepared.first.stdout), [])
    assert.equal(prepared.first.code, 0)
  }],
  ['prepare-resumed', ['prepared'], 'a resumed run whose one variant left is the last of the list runs it first in a fresh worker, after the same setup, and it passes', ({ prepared }) => {
    ran(prepared.whole, 'the whole run')
    assert.equal(totalsOf(prepared.whole.stdout), '3 of 3')
    ran(prepared.resumed, 'the resumed run')
    assert.ok(/resumed: 2 of 3 variants done/.test(prepared.resumed.stdout), prepared.resumed.stdout.split('\n')[0])
    assert.deepStrictEqual(prepared.resumedLedger.map(([key]) => key), ['p3'], 'the resumed run ran p3 alone')
    assert.equal(totalsOf(prepared.resumed.stdout), '3 of 3')
    assert.deepStrictEqual(harnessOf(prepared.resumed.stdout), [])
    assert.equal(prepared.resumed.code, 0)
  }],
  ['prepare-lazy', ['prepared'], 'the same wait made by the first variant that needs it instead of the setup fails that variant by name, with the step it was at: the wait does outlast a variant\'s deadline', ({ prepared }) => {
    ran(prepared.lazy, 'the run whose first variant waits for the child')
    harnessIs(prepared.lazy, 'p2: the variant p2 did not finish in 3 s; the last step it reached: the child of the setup')
    assert.equal(prepared.lazy.code, 2)
  }],
  ['child-limit', ['prepared'], 'a child past its limit (check-pool `startChild`) is ended with everything it started, before the setup deadline, and its result says that it did not finish', ({ prepared }) => {
    ran(prepared.limited, 'the run whose setup\'s child does not end')
    assert.deepStrictEqual(harnessOf(prepared.limited.stdout), [])
    assert.ok(/^FAIL {2}p1$/m.test(prepared.limited.stdout), 'p1 failed as a check')
    assert.ok(/^ {2}the child did not finish in 8 s$/m.test(prepared.limited.stdout), prepared.limited.stdout.trim().split('\n').slice(-3).join(' | '))
  }],
  ['child-race', ['racing'], 'a child that ends well past its limit, while it is being ended, reads as one that did not finish, never as one that succeeded', ({ racing }) => {
    ran(racing, 'the run whose setup\'s child ends as it is being ended')
    assert.deepStrictEqual(harnessOf(racing.stdout), [])
    assert.ok(/^FAIL {2}p1$/m.test(racing.stdout), 'p1 failed as a check')
    assert.ok(/^ {2}the child did not finish in 2 s \(it had said that it slept\)$/m.test(racing.stdout), racing.stdout.trim().split('\n').slice(-3).join(' | '))
  }],
]

const EVERY = ['all', 'leaky', 'control', 'late', 'closing', 'interrupted', 'tornClose', 'deaths', 'setup', 'setupClose', 'resume', 'steps', 'repeated', 'prepared', 'racing']

/* eslint-disable no-template-curly-in-string */
// [name, from, to, scenarios to run, the check ids one of which must fail, the file rewritten (the runner when not given)]
const MUTANTS = [
  ['a variant past its deadline is never ended', 'arm(variant.deadline, `the variant ${variant.key}`)', 'arm(1e6, `the variant ${variant.key}`)', ['all'], ['deadline']],
  ['a worker is heard after its deadline has passed', 'if (reason) {', 'if (false) {', ['late'], ['late']],
  ['a defect of the harness is counted as passed', 'checks: 1, failures: 1, extra: {}, harness: reason', 'checks: 1, failures: 0, extra: {}, harness: reason', ['all'], ['totals']],
  ['an error a variant throws is not counted', 'if (harness && !own) {', 'if (false) {', ['all'], ['totals']],
  ['a control is credited though its reset failed', 'failures: harness ? own.checks : own.failures', 'failures: own.failures', ['control'], ['control-reset']],
  ['a worker that ends is not charged to its variant', 'failed(ended.current.variant, ended.reason, ended.current.lines, (Date.now() - ended.current.began) / 1000)', 'void ended', ['all'], ['crash']],
  ['nothing bounds the close of a worker', "arm(between, 'the close of the worker')", 'clearTimeout(timer)', ['closing', 'setupClose'], ['closing', 'setup-close']],
  ['the close is bounded by the setup deadline', "arm(between, 'the close of the worker')", "arm(setup, 'the close of the worker')", ['closing', 'setupClose'], ['closing', 'setup-close']],
  ['the close is not said as it begins', "    say('closing')\n", '', ['closing', 'setupClose'], ['closing', 'setup-close']],
  ['a setup that throws is not said', '      say(`unprepared ${firstLine(error)}`)\n', '', ['setup', 'setupClose'], ['setup', 'setup-close']],
  ['the error of a setup that throws is not heard', 'unprepared = body', 'void body', ['setup', 'setupClose'], ['setup', 'setup-close']],
  ['the deadline the close of a failed setup ran past is dropped', "${ended.expired ? `; ${ended.reason}` : ''}", '', ['setupClose'], ['setup-close']],
  ['a defect of a worker is not kept in the record', 'fs.appendFileSync(file, `${JSON.stringify({ problem: text })}\\n`)', 'void text', ['closing'], ['closing-resume']],
  ['the control skips the reset between the fault and the head', '    await afterEach(target)\n', '', ['all'], ['control']],
  ['the breaker never stops a queue whose workers keep dying', 'if (rest.length && deaths >= DEATHS) {', 'if (false) {', ['deaths'], ['deaths']],
  ['a worker that finished a variant counts toward the breaker', 'deaths = ended.done.length ? 0 : deaths + 1', 'deaths = ended.done.length ? 1 : deaths + 1', ['deaths'], ['deaths']],
  ['the record is not written as each variant ends', 'fs.appendFileSync(file, `${JSON.stringify(defect ? { ...result, problem: defect } : result)}\\n`)', 'void file', ['resume'], ['resume-skips']],
  ['a resumed run runs again what was done', 'const results = new Map(resumed ? [...resumed.done].filter(([key]) => byKey.has(key)) : [])', 'const results = new Map()', ['resume'], ['resume-skips']],
  ['a line cut off is left in the record', 'fs.truncateSync(file, resumed.size)', 'void file', ['resume'], ['resume-torn']],
  ['a record is resumed with another list of variants', 'if (JSON.stringify(kept.variants) !== JSON.stringify(header.variants)) {', 'if (false) {', ['resume'], ['refuse-list']],
  ['a record is resumed over a changed save', 'if (kept.inputs !== header.inputs) {', 'if (false) {', ['resume'], ['refuse-inputs']],
  ['a save is fingerprinted without its bytes', 'hashFile(hash, input)', 'void input', ['resume'], ['refuse-inputs']],
  ['the last variant of a queue is written before its worker has ended', 'last = kept', 'keep(kept)', ['interrupted'], ['closing-stopped']],
  ['the defect of a worker is written apart from its last variant, after it', 'keep(ended.last, defect)', 'keep(ended.last), defect && problem(defect)', ['tornClose'], ['closing-torn']],
  ['a record is resumed over a changed tree', 'if (kept.tree !== header.tree) {', 'if (false) {', ['resume'], ['refuse-tree']],
  ['a step said is not kept', 'reached = body', 'void body', ['steps'], ['step-named']],
  ['a step the setup said is named by the deadline of the first variant', 'lines: pending }\n          reached = null', 'lines: pending }', ['steps'], ['step-reset']],
  ['the step of the setup is named by the deadline of the close after it failed', "          reached = null\n          arm(between, 'the close of the worker')", "          arm(between, 'the close of the worker')", ['setupClose'], ['setup-close']],
  ['a step said outside a worker is printed', 'if (inWorker) {', 'if (true) {', ['steps'], ['step-quiet']],
  ['the steps of an observation do not reach the runner', 'step: (phase) => { record.phase = phase; at(record, phase) }', 'step: (phase) => { record.phase = phase }', ['steps'], ['step-named'], OBSERVER],
  ['an observation that ends hides the step of one still open beside it', 'open.delete(record)', 'open.clear()', ['steps'], ['step-named'], OBSERVER],
  ['a key given again keeps its own key', 'return run === 1 ? key : `${key}#${run}`', 'return key', ['repeated'], ['repeat']],
  ['a worker does not know the run of a key given again', 'parsed.worker.map((key) => runOf(byKey, key))', 'parsed.worker.map((key) => byKey.get(key))', ['repeated'], ['repeat']],
  ['the setup is handed the run of a key given again', 'await prepare(queue.map(defined))', 'await prepare(queue)', ['repeated'], ['repeat']],
  ['the reset is handed the run of a key given again', 'await afterEach(defined(variant))', 'await afterEach(variant)', ['repeated'], ['repeat']],
  ['the wait of the setup is charged to the deadline of the first variant', '    try {\n      await prepare(queue.map(defined))', '    say(`begin ${queue[0].key}`)\n    try {\n      await prepare(queue.map(defined))', ['prepared'], ['prepare-first']],
  ['a child past its limit is never ended', 'const timer = limit ? setTimeout(', 'const timer = false ? setTimeout(', ['prepared'], ['child-limit'], POOL],
  ['a child ended at its limit is not said to be', '    timedOut = true\n', '', ['prepared'], ['child-limit'], POOL],
  ['a child that ends as it is ended at its limit keeps its own status', 'code: timedOut ? null : code', 'code', ['racing'], ['child-race'], POOL],
]

// Rewrites of the runner that change nothing a run does: each must leave every check of the scenarios it touches passing. [name, from, to, scenarios to run]
const BENIGN = [
  ['the trees compared the other way round', 'if (kept.tree !== header.tree) {', 'if (header.tree !== kept.tree) {', ['resume']],
  ['the deadline given as a number', 'arm(variant.deadline, `the variant ${variant.key}`)', 'arm(Number(variant.deadline), `the variant ${variant.key}`)', ['all', 'late']],
  ['a step kept to a longer cut', '.slice(0, 300)', '.slice(0, 400)', ['steps']],
]
/* eslint-enable no-template-curly-in-string */

const judge = (seen, needs) => CHECKS.filter(([, wanted]) => wanted.every((need) => needs.includes(need))).map(([id, , name, run]) => {
  try {
    run(seen)

    return { id, name, ok: true, detail: '' }
  } catch (error) {
    return { id, name, ok: false, detail: String(error.message).split('\n')[0].slice(0, 600) }
  }
})

const main = async () => {
  const mutations = !process.argv.includes('--no-mutations')
  let checks = 0
  let failures = 0
  const check = (name, ok, detail = '') => {
    checks++

    if (!ok) {
      failures++
    }

    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` (${detail})`}`)
  }
  const sources = { [RUNNER]: fs.readFileSync(path.join(LIB, 'suite-runner.js'), 'utf8'), [OBSERVER]: fs.readFileSync(path.join(LIB, 'browser-observe.js'), 'utf8'), [POOL]: fs.readFileSync(path.join(LIB, 'check-pool.js'), 'utf8') }

  for (const result of judge(await observe(sources, EVERY), EVERY)) {
    check(result.name, result.ok, result.detail)
  }

  if (mutations) {
    console.log('\nPlanted faults')

    for (const [name, from, to, needs, caught, file = RUNNER] of MUTANTS) {
      const failed = judge(await observe({ ...sources, [file]: patched(file, sources[file], from, to) }, needs), needs).filter((result) => !result.ok).map((result) => result.id)

      check(`planted: ${name}: caught by ${failed.join(', ') || 'nothing'}`, caught.some((id) => failed.includes(id)), `expected one of ${caught.join(', ')}`)
    }

    console.log('\nBenign rewrites')

    for (const [name, from, to, needs] of BENIGN) {
      const failed = judge(await observe({ ...sources, [RUNNER]: patched(RUNNER, sources[RUNNER], from, to) }, needs), needs).filter((result) => !result.ok)

      check(`benign: ${name}: no check fails`, failed.length === 0, failed.map((result) => `${result.id}: ${result.detail}`).join('; '))
    }
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exitCode = failures ? 1 : 0
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
