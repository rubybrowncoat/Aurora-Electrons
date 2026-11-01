/*
  Checks scripts/lib/suite-runner.js, the runner the long check suites run their heads and variants through, on a suite made for it (scripts/lib/suite-runner-fixture.js) whose variants pass, fail, hang, spin, crash, throw and end late.

  Run: bun scripts/check-suite-runner.js [--no-mutations]

  Each scenario copies the runner, scripts/lib/check-pool.js, scripts/lib/browser-observe.js and the suite into a layout of its own under the temp folder (a file of its own under `src` stands for the tree, saves/input.db for the suite's inputs), runs the suite there (scripts/lib/check-pool.js `startChild`, ended at its limit of 45 s whatever it does) and reads what it printed, the record it left and the ledger in which each variant noted the process it ran in:
  - `all`: the variants print in the order of the list whatever ends when; a variant that hangs or spins past its deadline, and one whose worker ends, fails by name as a defect of the harness and the run goes on in a fresh worker; an error a variant throws fails it by name and its worker goes on; the totals count each once and the run ends with status 2; the control (the fault, then the head, in one worker) passes;
  - `leaky`: the same suite whose reset leaves the fault's state behind: the control fails;
  - `control`: a control whose own reset fails is failed, never credited;
  - `late`: in a layout whose copy of check-pool waits 1.5 s before it ends a process, as a loaded machine's taskkill can, a variant that ends half a second after its deadline, while its worker is being ended, still fails by name;
  - `closing`: a worker whose reset fails ends, its close (10 s) is ended at the `between` deadline (4 s), which the setup deadline (15 s) would not end, and named as a defect of the run, as the close of the worker, the variant after it runs in a fresh worker, and a resumed run reports the defect again;
  - `interrupted`: a run stopped while its last worker closes (a close whose failure is held until its actual beginning is witnessed) has not written that worker's last variant, so the resumed run runs it again and reports the close that fails;
  - `tornClose`: a whole run whose last worker's close fails, with the last line of its record cut in half, is resumed with that worker's last variant run again and its close reported, never green;
  - `deaths`: a worker that finishes a variant before it ends starts the count again; after three workers in a row end without finishing one, the rest of the queue fails by name and is never started;
  - `setup`: a setup that fails fails every variant of the queue by name, by the error it threw, none started;
  - `setupClose`: a setup that fails, whose close (10 s) is ended at the `between` deadline (4 s), which the setup deadline (15 s) would not end: every variant of the queue fails by the error of the setup and by the deadline of the close, with no step the setup said;
  - `resume`: a run ended in the middle of a variant and resumed runs only the variants not recorded, and its totals are those of a whole run; a whole record resumed again runs nothing; a record whose last line was cut in half is resumed, and resumed again, without running a variant twice; a record is not resumed with another list of variants, once its save changed (to bytes of the same length, its time of last write put back), nor once a file of the tree changed;
  - `steps`: variants that say their steps (`step` of the runner, and `observe` of browser-observe for the steps of its work) and stall: a deadline names the last step its variant said, its own or its observation's, the step of the observation still open when another beside it has ended, and none for a variant that said none after a setup that said one, nor for a close (10 s, ended at 4 s) after a variant that said one; no step reaches the output, nor one said outside a worker;
  - `repeated`: `--variants` that names a key again runs it again, each run a variant of its own (`pass#2`) counted once, in one worker, whose setup and reset are handed the variant the suite defined; resumed with only the last repeat left (its line of the record torn), the run runs that repeat alone, on a setup handed the variant of its key;
  - `prepared`: a setup that waits for a child (4.5 s, under the limit of 8 s that check-pool's `startChild` puts on it), longer than a variant's deadline (3 s) and within the setup's (15 s), as the setup of scripts/check-specialist-deployments.js waits for the cases it reads in children: a variant that comes first in a fresh worker (`--variants`) or in a resumed run passes, the same wait in the first variant instead fails it by name, and a child past its limit is ended and said to be;
  - `racing`: in a layout whose copy of check-pool waits 4 s before it ends a process, the setup's child, with a limit of 2 s, ends well at 3 s while it is being ended: it reads as a child that did not finish, never as one that succeeded;
  - `widthDefault`, `widthExplicit`, `widthCap`, `widthOrdered`, `widthDeaths`, `widthInvalid`: in a layout whose copy of check-pool takes the machine for the threads FAKE_THREADS gives (8, so 4 cores, unless a scenario says 4) and notes in children.txt each worker the runner starts, with the variants it is handed, and ends, and whose suite names the width FAKE_WORKERS gives (JSON): a suite that names none runs as many workers as CHECK_JOBS says (2, not the 4 cores), the variants of its pool dealt round robin to them; one that names a width (3, with CHECK_JOBS=1) runs that many side by side, dealt round robin, with the totals and the record of each variant of the run in one worker, and no more than the cores (3 asked of 2); `--variants` still runs one worker, in its order, whatever the width; a worker that dies at a width of 2 is counted by the breaker, three in a row ending the rest of its queue by name; a width of 0, -2, 2.5 or "x" names none, and the run is the default's;
  - `grouped`: a group of faults planted together (a variant with `members`) runs once, handed all its members, under the key of the group, and is resumed by that key; `solo`: with `--solo` each member runs alone as a variant of its own (`group/member`), handed only itself, the record of such a run is a run of its own, and `--variants=group/member` runs one; `selected`: `--only` matches the names of the members, whole or with `--solo`; `groupControl`: a control that names a group runs it, also with `--solo`; `groupHang`: a group that hangs fails by name, and with `--solo` only the member that hangs; `declared`: a group the runner refuses (too few members, a key that cannot be told apart, no name, no list of checks, a key or a name twice, faults and rewrites together, one check named by two members) stops the run before anything starts.
  Each planted fault rewrites one line of the copy of the runner (or of browser-observe or check-pool) and must make a named check fail; each benign rewrite must make none of the checks of the scenarios it touches fail.
  Invalid-width checks require a successful fixture exit, its complete six-variant totals and record, before judging the observed worker width. Their plants choose the cores instead of CHECK_JOBS for each invalid class, keeping the run complete; an invalid width that crashes the runner is a defect of the harness, never fault credit.

  --only=<scenario>,<scenario> runs those complete head contexts and only faults/rewrites whose declared contexts all appear in that list.
  Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const { randomUUID } = require('crypto')
const { EventEmitter } = require('events')
const nodeVm = require('vm')
const acorn = require('acorn')
const { HarnessError } = require('./lib/browser-observe')
const { assert, kindOf } = require('./lib/fault-credit')
const { startChild } = require('./lib/check-pool')
const { patched, plantedPatch } = require('./lib/mutant-source')
const { mutating } = require('./lib/no-mutations')

const LIB = path.join(__dirname, 'lib')
const SELF = 'scripts/check-suite-runner.js'
const RUNNER = 'scripts/lib/suite-runner.js'
const OBSERVER = 'scripts/lib/browser-observe.js'
const POOL = 'scripts/lib/check-pool.js'
const FIXTURE = 'suite-runner-fixture.js'
const LIMIT = 45000
// The scenarios whose layout ends a process that long (ms) after it is asked to.
const KILL_DELAYS = { late: 1500, racing: 4000 }
// The scenarios whose layout takes the machine for the threads FAKE_THREADS gives, notes each worker the runner starts and ends in children.txt, lets the suite name its width by FAKE_WORKERS (JSON) and holds the set `wide`.
const WIDTHS = ['widthDefault', 'widthExplicit', 'widthCap', 'widthOrdered', 'widthDeaths', 'widthInvalid']

// A value oracle for the private parent timer witness. Bounds come from the fixture, never from the timer being judged; no elapsed duration is synthesized here.
const closeArmOf = (witness, expected) => {
  if (!witness || witness.run !== expected.run || witness.parent !== expected.parent || witness.phase !== 'close-begin' || !Number.isInteger(witness.pid) || witness.pid <= 0 || witness.pid !== witness.ownedPID || witness.probeCount !== 1 || !Array.isArray(witness.done) || !Number.isInteger(witness.dispatchID) || witness.dispatchID < 1 || typeof witness.ready !== 'boolean' || !witness.ownerAlive || witness.ownerDone || witness.parentReason || !Number.isFinite(witness.parentStart) || !Number.isFinite(witness.ownerAt) || !Number.isFinite(witness.parentEntered) || !Number.isFinite(witness.parentAt) || witness.ownerAt < witness.parentStart || witness.parentEntered < witness.ownerAt || witness.parentAt < witness.parentEntered) {
    throw new HarnessError('invalid close phase, parent, worker or ownership witness')
  }

  if (expected.context === 'closing' && (!witness.ready || witness.unprepared !== null || witness.done.length !== 1 || witness.done[0] !== 'x1' || witness.currentKey !== null)) {
    throw new HarnessError('the close probe did not follow the owned x1 reset completion')
  }

  if (expected.context === 'setupClose' && (witness.ready || witness.unprepared !== 'a setup planted to fail' || witness.done.length || witness.currentKey !== null)) {
    throw new HarnessError('the close probe did not follow the owned setup failure')
  }

  if (!['closing', 'setupClose'].includes(expected.context) || expected.betweenMS !== 4000) {
    throw new HarnessError('unknown close bound fixture contract')
  }

  const timer = witness.activeTimer

  if (timer && (timer.run !== expected.run || timer.pid !== witness.pid || timer.ownerAt !== witness.ownerAt || timer.fired || timer.cleared || !Number.isFinite(timer.delay) || !Number.isFinite(timer.at) || timer.at < witness.ownerAt || timer.at > witness.parentAt || !Number.isInteger(timer.dispatchID) || timer.dispatchID >= witness.dispatchID)) {
    throw new HarnessError('unrelated, early, old or expired close timer witness')
  }

  return { correct: Boolean(timer && timer.delay === expected.betweenMS && timer.dispatch === 'closing'), delay: timer?.delay ?? null, dispatch: timer?.dispatch ?? null }
}

// Stable text written only into a private close-arm layout. Real timer callbacks/delays are passed through unchanged; the sentinel follows the worker's actual closing message, even when that message is missing under a fault.
const closeTimerModule = () => {
  const fs = require('fs')
  const path = require('path')
  const native = require('timers')
  const run = process.env.FAKE_RUN_ID
  const parentStart = performance.now()
  const owners = new Map()
  const timers = new Map()
  let current = null
  let dispatchID = 0
  let entered = 0

  if (!/^[a-f0-9-]{36}$/.test(run || '') || process.env.CHECK_JOBS !== '1') {
    throw new Error('a close-arm observer has no private sequential run identity')
  }

  const alive = (pid) => {
    try {
      process.kill(pid, 0)

      return true
    } catch (error) {
      return error.code === 'EPERM'
    }
  }
  const setTimeout = (fire, delay, ...args) => {
    const record = { run, pid: current?.pid, ownerAt: current?.ownerAt, at: performance.now(), delay, dispatch: current?.word || 'setup', dispatchID, cleared: false, fired: false }
    const timer = native.setTimeout((...values) => {
      record.fired = true
      fire(...values)
    }, delay, ...args)

    timers.set(timer, record)

    return timer
  }
  const clearTimeout = (timer) => {
    const record = timers.get(timer)

    if (record) {
      record.cleared = true
    }

    native.clearTimeout(timer)
  }
  const owner = (handle, queue) => {
    const own = { pid: handle.pid, ownerAt: performance.now(), pending: true, queue: queue.map(({ key }) => key), probes: 0, word: 'setup' }

    owners.set(handle.pid, own)
    current = own
    handle.done.then(() => { own.pending = false }, () => { own.pending = false })
  }
  const dispatch = (handle, line, stream, invoke, snapshot) => {
    const own = owners.get(handle.pid)
    const word = stream === 'stdout' && line.startsWith('@@suite-runner ') ? line.slice(15).split(' ')[0] : 'unrelated'
    const previous = current

    current = { ...own, word }
    dispatchID++
    entered = performance.now()

    try {
      invoke()
      if (word !== 'close-probe' || own.queue[0] !== 'x1') {
        return
      }

      const marker = JSON.parse(line.slice('@@suite-runner close-probe '.length))
      const state = snapshot()
      const timer = timers.get(state.timer)
      if (marker.run !== run || marker.pid !== handle.pid || marker.phase !== 'close-begin') {
        throw new Error('a close probe names another run or worker')
      }

      const witness = { ...marker, ...state, ownedPID: handle.pid, timer: undefined, run: marker.run, pid: marker.pid, parent: process.pid, parentStart, ownerAt: own.ownerAt, parentEntered: entered, parentAt: performance.now(), dispatchID, probeCount: ++own.probes, ownerAlive: alive(handle.pid), ownerDone: !own.pending, activeTimer: timer && !timer.cleared ? { ...timer } : null }
      const file = path.join(__dirname, '..', '..', `close-arm-${run}.json`)

      fs.writeFileSync(`${file}.next`, JSON.stringify(witness))
      fs.renameSync(`${file}.next`, file)
    } catch (error) {
      console.error(`close-arm observer failed: ${error.stack || error}`)
      process.exit(2)
    } finally {
      current = previous
    }
  }

  return { setTimeout, clearTimeout, owner, dispatch }
}

// Retained low-cost discriminator controls execute the actual oracle extracted from this tree. The SELF fault accepts an end/setup timer as a close timer and must change a boolean value here.
const closeArmObservation = (source) => {
  const definition = acorn.parse(source, { ecmaVersion: 'latest' }).body.filter((node) => node.type === 'VariableDeclaration').flatMap((node) => node.declarations).find((node) => node.id.type === 'Identifier' && node.id.name === 'closeArmOf')

  if (!definition) {
    throw new HarnessError('the close-arm control found no value oracle')
  }

  const oracle = nodeVm.runInNewContext(`(${source.slice(definition.init.start, definition.init.end)})`, { HarnessError })
  const expected = { run: '12345678-1234-1234-1234-123456789abc', parent: 4321, context: 'closing', betweenMS: 4000 }
  const head = { run: expected.run, parent: expected.parent, pid: 1234, ownedPID: 1234, phase: 'close-begin', parentStart: 1, ownerAt: 2, parentEntered: 4, parentAt: 5, dispatchID: 4, probeCount: 1, ownerAlive: true, ownerDone: false, parentReason: null, ready: true, unprepared: null, done: ['x1'], currentKey: null, activeTimer: { run: expected.run, pid: 1234, ownerAt: 2, at: 3, delay: 4000, dispatch: 'closing', dispatchID: 3, cleared: false, fired: false } }
  const copy = () => JSON.parse(JSON.stringify(head))
  const wrongDispatch = copy()

  wrongDispatch.activeTimer.dispatch = 'end'
  const missing = copy()

  missing.activeTimer = null
  const wrongBound = copy()

  wrongBound.activeTimer.delay = 15000
  const setup = copy()

  setup.ready = false
  setup.unprepared = 'a setup planted to fail'
  setup.done = []
  const rejected = []
  const bads = {
    oldRun: (witness) => { witness.run = 'old' },
    wrongParent: (witness) => { witness.parent++ },
    wrongWorker: (witness) => { witness.pid++ },
    duplicate: (witness) => { witness.probeCount++ },
    earlyPhase: (witness) => { witness.done = [] },
    unrelatedTimer: (witness) => { witness.activeTimer.run = 'old' },
    earlyTimer: (witness) => { witness.activeTimer.at = 6 },
    oldOwner: (witness) => { witness.activeTimer.ownerAt = 1 },
    earlyDispatch: (witness) => { witness.activeTimer.dispatchID = 4 },
    fired: (witness) => { witness.activeTimer.fired = true },
    cleared: (witness) => { witness.activeTimer.cleared = true },
    ended: (witness) => { witness.ownerDone = true },
    dead: (witness) => { witness.ownerAlive = false },
    expired: (witness) => { witness.parentReason = 'deadline' },
  }

  for (const [name, change] of Object.entries(bads)) {
    const witness = copy()

    change(witness)
    try {
      oracle(witness, expected)
      rejected.push({ name, rejected: false })
    } catch (error) {
      if (!(error instanceof HarnessError)) {
        throw error
      }

      rejected.push({ name, rejected: true })
    }
  }

  return { head: oracle(head, expected), setup: oracle(setup, { ...expected, context: 'setupClose' }), wrongDispatch: oracle(wrongDispatch, expected), missing: oracle(missing, expected), wrongBound: oracle(wrongBound, expected), rejected }
}

// An independent witness that the runner parent consumed the worker's actual phase IPC. It reads no record or outcome under test, so a missing/premature record remains a value failure.
const phaseAck = (phase) => `
          if (process.env.FAKE_BARRIER === '${phase}'${phase === 'r4' ? " && body === 'r4'" : phase === 'deadline' ? ' && body === process.env.FAKE_DEADLINE_PROBE' : ''}) {
            const observed = path.join(ROOT, 'phase-observed-' + process.env.FAKE_RUN_ID + '.json')

            fs.writeFileSync(observed + '.next', JSON.stringify({ run: process.env.FAKE_RUN_ID, phase: '${phase}', pid: handle.pid, at: ${phase === 'deadline' ? 'current.began' : 'Date.now()'} }))
            fs.renameSync(observed + '.next', observed)
          }
`
// check-pool as a layout of widths has it: the threads of the machine as FAKE_THREADS gives them (the cores are half), and a line in children.txt at the root of the layout for each worker the runner starts, as it starts with the variants it is handed, and as it ends.
const countedPool = (pool) => patched(POOL, patched(POOL, pool, 'const threads = () => (os.availableParallelism', 'const threads = () => Number(process.env.FAKE_THREADS) || (os.availableParallelism'), '  return { pid: child.pid, kill: () => killTree(child.pid), done }\n', `  const note = (text) => require('fs').appendFileSync(require('path').join(__dirname, '..', '..', 'children.txt'), text + '\\n')\n\n  note('start ' + child.pid + ' ' + args.filter((argument) => argument.startsWith('--worker=')).join(''))\n  done.then(() => note('end ' + child.pid), () => note('end ' + child.pid))\n\n  return { pid: child.pid, kill: () => killTree(child.pid), done }\n`)

// The suite as a layout of widths has it: the width its caller names in FAKE_WORKERS (JSON: 3, 0, "x"), and the set `wide`, which two workers are dealt round robin: the first holds the variants that die (c1, c2, c3) and the two after them, the second w1 to w4.
const wideFixture = (fixture) => patched(FIXTURE, patched(FIXTURE, fixture, '    setup: 15,\n', "    setup: 15,\n    ...(process.env.FAKE_WORKERS ? { workers: JSON.parse(process.env.FAKE_WORKERS) } : {}),\n"), "  prepared: () => [prepared('p1'), prepared('p2'), prepared('p3')],\n", "  wide: () => [crashing('c1'), passing('w1'), crashing('c2'), passing('w2'), crashing('c3'), passing('w3'), passing('d4'), passing('w4'), passing('d5')],\n  prepared: () => [prepared('p1'), prepared('p2'), prepared('p3')],\n")

// A layout of its own: the runner, browser-observe and check-pool as given in `sources` (by RUNNER, OBSERVER and POOL; check-pool slow to end a process by `killDelay` ms) and the suite, a file of the tree and the suite's save; with `widths`, the layout of the scenarios of widths.
const layoutOf = (sources, killDelay, closeArm = false, finiteFailures = false, widths = false) => {
  const layout = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-suite-runner-'))
  const lib = path.join(layout, 'scripts', 'lib')

  fs.mkdirSync(lib, { recursive: true })
  fs.mkdirSync(path.join(layout, 'src'))
  fs.mkdirSync(path.join(layout, 'saves'))
  fs.writeFileSync(path.join(layout, 'src', 'one.js'), 'module.exports = 1\n')
  fs.writeFileSync(path.join(layout, 'saves', 'input.db'), 'a save\n')
  const acknowledged = patched(RUNNER, sources[RUNNER], "} else if (word === 'closing') {", `} else if (word === 'closing') {${phaseAck('closing')}`)
  const phased = patched(RUNNER, acknowledged, '          const variant = byKey.get(body)\n', `          const variant = byKey.get(body)\n${phaseAck('r4')}`)
  const begun = patched(RUNNER, phased, '          current = { variant, began: Date.now(), lines: pending }\n', `          current = { variant, began: Date.now(), lines: pending }\n${phaseAck('deadline')}`)
  const runner = patched(RUNNER, begun, '      live.delete(handle)\n', '      live.delete(handle)\n      if (process.env.FAKE_BARRIER === \'deadline\') {\n        const ended = path.join(ROOT, \'phase-ended-\' + process.env.FAKE_RUN_ID + \'-\' + handle.pid + \'.json\')\n\n        fs.writeFileSync(ended + \'.next\', JSON.stringify({ run: process.env.FAKE_RUN_ID, pid: handle.pid, at: Date.now() }))\n        fs.renameSync(ended + \'.next\', ended)\n      }\n')

  let observedRunner = runner

  if (closeArm) {
    const callback = '{ onLine: (line, stream) => closeProbe.dispatch(handle, line, stream, () => onLine(line, stream), () => ({ timer, ready, unprepared, done: [...done], currentKey: current?.variant.key || null, parentReason: reason })) })'

    observedRunner = "const closeProbe = require('./close-arm-probe')\nconst { setTimeout, clearTimeout } = closeProbe\n" + patched(RUNNER, patched(RUNNER, runner, '{ onLine })', callback), '    live.add(handle)\n', '    closeProbe.owner(handle, queue)\n    live.add(handle)\n')
    fs.writeFileSync(path.join(lib, 'close-arm-probe.js'), `module.exports = (${closeTimerModule.toString()})()\n`)
  }

  fs.writeFileSync(path.join(lib, 'suite-runner.js'), observedRunner)
  fs.writeFileSync(path.join(lib, 'browser-observe.js'), sources[OBSERVER])
  const pool = killDelay ? patched(POOL, sources[POOL], 'const killTree = (pid) => {', `const killTree = (pid) => {\n  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${killDelay})`) : sources[POOL]

  fs.writeFileSync(path.join(lib, 'check-pool.js'), widths ? countedPool(pool) : pool)
  const fixture = fs.readFileSync(path.join(LIB, FIXTURE), 'utf8')

  let configured = closeArm ? patched(FIXTURE, fixture, '    close: async () => {\n', "    close: async () => {\n      if (process.env.FAKE_CLOSE_ARM) {\n        console.log('@@suite-runner close-probe ' + JSON.stringify({ run: process.env.FAKE_RUN_ID, pid: process.pid, phase: 'close-begin' }))\n      }\n") : fixture

  if (finiteFailures) {
    configured = patched(FIXTURE, patched(FIXTURE, configured, "variant('hang', never)", "crashing('hang')"), "variant('spin', async () => { while (Date.now() > 0) { state.beats++ } })", "crashing('spin')")
  }

  if (widths) {
    configured = wideFixture(configured)
  }

  fs.writeFileSync(path.join(lib, FIXTURE), configured)

  return layout
}

// A fixture phase is private to this invocation, including resumed runs. The actual worker writes its marker atomically; the parent witnesses that worker alive in its ledger before interrupting the owned process tree through check-pool.
const alive = (pid) => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
const DEADLINE_UPPER_MS = 10000
const runIn = async (layout, args, { env = {}, stopAt = null, observeDeadline = false, observeClose = null } = {}) => {
  if (stopAt !== null && !['r4', 'closing'].includes(stopAt)) {
    throw new HarnessError(`unknown fixture interruption phase: ${stopAt}`)
  }

  if (observeDeadline && stopAt !== null) {
    throw new HarnessError('a deadline observation cannot also interrupt another fixture phase')
  }

  if (observeClose !== null && (!['closing', 'setupClose'].includes(observeClose) || observeDeadline || stopAt !== null)) {
    throw new HarnessError('unknown or overlapping close-arm observation')
  }

  const phaseName = observeDeadline ? 'deadline' : stopAt
  const run = randomUUID()
  const marker = path.join(layout, `phase-${run}.json`)
  const observed = path.join(layout, `phase-observed-${run}.json`)
  const closeFile = path.join(layout, `close-arm-${run}.json`)
  const handle = startChild(path.join(layout, 'scripts', 'lib', FIXTURE), args, { env: { ...env, FAKE_RUN_ID: run, FAKE_BARRIER: phaseName || '', FAKE_DEADLINE_PROBE: observeDeadline ? 'hang' : '', FAKE_CLOSE_ARM: observeClose || '' }, limit: LIMIT })
  let closeArm = null
  let closeStopped = false
  let rootDone = false

  handle.done.then(() => { rootDone = true }, () => { rootDone = true })
  let stoppedAt = null
  let deadline = null
  let problem = null
  let timer = null
  const stop = (error = null) => {
    clearInterval(timer)
    problem = error
    handle.kill()
  }

  if (phaseName || observeClose) {
    timer = setInterval(() => {
      if (stoppedAt || problem) {
        return
      }

      if (observeClose && !closeArm && fs.existsSync(closeFile)) {
        try {
          const witness = JSON.parse(fs.readFileSync(closeFile, 'utf8'))
          const value = closeArmOf(witness, { run, parent: handle.pid, context: observeClose, betweenMS: 4000 })

          if (rootDone || !alive(handle.pid) || !alive(witness.pid)) {
            throw new HarnessError('the close-arm producer or worker ended before its observation')
          }

          closeArm = { witness, ...value, earlyStopped: !value.correct, cleaned: false, ownedHandlePending: true }
          if (!value.correct) {
            closeStopped = true
            stop()
          }
        } catch (error) {
          stop(error instanceof HarnessError ? error : new HarnessError(`the close-arm witness could not be read: ${error.message}`))
        }
      }

      if (!phaseName) {
        return
      }

      if (deadline) {
        // The unchanged deadline assertion has always required completion below 10 s. This is a witnessed live worker beyond that bound, distinct from the outer safety watchdog.
        if (Date.now() - deadline.parentObserved >= DEADLINE_UPPER_MS && !fs.existsSync(path.join(layout, `phase-ended-${run}-${deadline.pid}.json`)) && alive(deadline.pid)) {
          stoppedAt = { ...deadline, overdue: true, ownedHandlePending: true, observed: Date.now() }
          stop()
        }

        return
      }

      if (!fs.existsSync(marker) || !fs.existsSync(observed)) {
        return
      }

      try {
        const phase = JSON.parse(fs.readFileSync(marker, 'utf8'))
        const ack = JSON.parse(fs.readFileSync(observed, 'utf8'))

        if (phase.run !== run || phase.phase !== phaseName || ack.run !== run || ack.phase !== phaseName || ack.pid !== phase.pid || !Number.isFinite(ack.at) || !Number.isInteger(phase.pid) || phase.pid <= 0 || !Number.isFinite(phase.at) || !ledgerOf(layout).some(([, pid]) => Number(pid) === phase.pid) || !alive(phase.pid)) {
          throw new HarnessError(`invalid or no longer live fixture phase: ${JSON.stringify(phase)}`)
        }

        const witnessed = { ...phase, parentObserved: ack.at, witnessed: Date.now(), alive: true }

        if (observeDeadline) {
          deadline = witnessed
        } else {
          stoppedAt = witnessed
          stop()
        }
      } catch (error) {
        stop(error instanceof HarnessError ? error : new HarnessError(`the fixture phase could not be read: ${error.message}`))
      }
    }, 25)
  }

  try {
    const result = await handle.done

    if (problem) {
      throw problem
    }

    if (observeClose) {
      if (!closeArm || result.timedOut || result.error || (closeStopped && result.stderr.trim())) {
        throw new HarnessError('the close-arm producer failed or did not publish its owned witness')
      }

      closeArm.cleaned = !alive(closeArm.witness.pid)
      if (!closeArm.cleaned || (closeStopped && alive(handle.pid))) {
        throw new HarnessError('the close-arm owned process tree survived cleanup')
      }
    }

    if (observeDeadline && (!deadline || (!stoppedAt && (result.timedOut || !/^HARNESS \[.*\]$/m.test(result.stdout) || !/\d+ of \d+ checks passed/.test(result.stdout))))) {
      throw new HarnessError('the deadline fixture did not produce a witnessed live worker and a complete result')
    }

    if (phaseName && ((stopAt && !stoppedAt) || (stoppedAt && alive(stoppedAt.pid)))) {
      throw new HarnessError(stoppedAt ? `the interrupted worker ${stoppedAt.pid} survived cleanup` : `the fixture never reached its requested phase ${stopAt}`)
    }

    return { ...result, run, stoppedAt, ...(observeClose ? { closeArm } : {}), ...(observeDeadline ? { deadline: { ...deadline, overdue: Boolean(stoppedAt?.overdue), ownedHandlePending: Boolean(stoppedAt?.ownedHandlePending), observed: stoppedAt?.observed || null, cleaned: stoppedAt ? !alive(stoppedAt.pid) : null } } : {}) }
  } finally {
    clearInterval(timer)
  }
}

// Independent controlled timestamps: an old worker phase cannot expire the parent's fresh begin clock. Both sides use the actual runIn function, including its readiness/ownership/cleanup gates; no native process or real timer starts here.
const deadlineClockObservation = async (source) => {
  if (typeof source !== 'string') {
    throw new HarnessError('the deadline clock control has no harness source')
  }

  const declaration = acorn.parse(source, { ecmaVersion: 'latest' }).body.filter((node) => node.type === 'VariableDeclaration').flatMap((node) => node.declarations).find((node) => node.id.type === 'Identifier' && node.id.name === 'runIn')

  if (!declaration) {
    throw new HarnessError('the deadline clock control found no runIn declaration')
  }

  const run = '12345678-1234-1234-1234-123456789abc'
  const pid = 1234
  const layout = path.join(os.tmpdir(), 'ae-clock-control')
  const phase = { run, phase: 'deadline', pid, at: 900 }
  const parent = { run, phase: 'deadline', pid, at: 19990 }
  const files = new Map([[path.join(layout, `phase-${run}.json`), JSON.stringify(phase)], [path.join(layout, `phase-observed-${run}.json`), JSON.stringify(parent)]])
  let callback
  let clock = 20000
  let live = true
  let killed = 0
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  const handle = { done, kill: () => { killed++; live = false; finish({ code: null, stdout: '', stderr: '', timedOut: false }) } }
  const context = nodeVm.createContext({ HarnessError, path, FIXTURE, LIMIT, DEADLINE_UPPER_MS, randomUUID: () => run, fs: { existsSync: (file) => files.has(file), readFileSync: (file) => files.get(file) }, alive: () => live, ledgerOf: () => [['hang', pid]], Date: { now: () => clock }, setInterval: (poll) => { callback = poll; return 1 }, clearInterval: () => {}, startChild: () => handle })
  const actual = nodeVm.runInContext(`(${source.slice(declaration.init.start, declaration.init.end)})`, context)
  const pending = actual(layout, [], { observeDeadline: true })

  callback()
  clock = 20001
  callback()
  const early = killed > 0

  if (!early) {
    clock = 29991
    callback()
  }

  const result = await pending

  return { early, parentElapsed: result.deadline.observed - result.deadline.parentObserved, workerElapsed: result.deadline.observed - result.deadline.at, laterOverdue: result.deadline.overdue, cleaned: result.deadline.cleaned, killed }
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

// The workers the runner started in the layout of widths after the first `from` lines of children.txt: the variants each was handed (sorted: they start together) and the most that ran at once; `lines` is how many lines the file holds.
const workersOf = (layout, from = 0) => {
  const file = path.join(layout, 'children.txt')
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  const queues = []
  let running = 0
  let peak = 0

  for (const line of lines.slice(from)) {
    const [event, , handed = ''] = line.split(' ')

    if (event === 'start') {
      queues.push(handed.slice('--worker='.length))
      peak = Math.max(peak, ++running)
    } else {
      running--
    }
  }

  return { lines: lines.length, queues: queues.sort(), peak }
}

// A run in a layout of widths, on a machine of eight threads (four cores) unless `env` says another: what it printed, its record and the lines of it after the header, and the workers the runner started.
const widthRun = async (layout, args, env = {}) => {
  const { lines } = workersOf(layout)
  const run = await runIn(layout, args, { env: { FAKE_THREADS: '8', ...env } })
  const file = recordFileOf(layout)

  return { ...run, record: recordOf(layout), rows: file ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length - 1 : 0, workers: workersOf(layout, lines) }
}

// A repaired record must be complete JSONL before another process is asked to read it. A malformed persisted line is an observed wrong value; an I/O/observer error still propagates as a harness failure.
const recordIntegrityOf = (layout) => {
  const observerIO = (read) => {
    try {
      return read()
    } catch (cause) {
      const error = new HarnessError(`the persisted record could not be inspected: ${cause.message}`)

      error.cause = cause
      throw error
    }
  }
  const file = observerIO(() => recordFileOf(layout))

  if (!file) {
    throw new HarnessError('the resumed run left no record to inspect')
  }

  const text = observerIO(() => fs.readFileSync(file, 'utf8'))
  let rows

  try {
    rows = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error
    }

    return { valid: false, detail: `the persisted JSONL is malformed: ${error.message.split('\n')[0]}`, text }
  }

  const header = rows[0]
  const valid = Boolean(text.endsWith('\n') && header && typeof header === 'object' && typeof header.tree === 'string' && typeof header.inputs === 'string' && Array.isArray(header.variants) && typeof header.began === 'string' && rows.slice(1).every((row) => row && typeof row === 'object' && !Array.isArray(row)))

  return { valid, detail: valid ? '' : 'the persisted record has no complete header/result protocol', text }
}

// The last line of the record cut in half, its line break with it, as a run stopped while it wrote the line leaves it.
const tear = (layout) => {
  const file = recordFileOf(layout)
  const text = fs.readFileSync(file, 'utf8')
  const start = text.slice(0, -1).lastIndexOf('\n') + 1

  fs.writeFileSync(file, text.slice(0, start + Math.floor((text.length - start) / 2)))
}

const inLayout = async (sources, need, checks = null, context = null) => {
  if (['deadlineClock', 'closeArmWitness', 'listWitness', 'childWitness'].includes(need)) {
    return SCENARIOS[need](sources[SELF], sources[POOL])
  }

  const layout = layoutOf(sources, KILL_DELAYS[need] || 0, context === 'close-arm', context === 'finite-failures', WIDTHS.includes(need))

  try {
    return await SCENARIOS[need](layout, checks, context)
  } finally {
    fs.rmSync(layout, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

const RESUME = ['--set=resume', '--resume']
const REPEAT = ['--set=all', '--variants=pass,fail,pass,pass']
const CLOSING = { FAKE_RESET_FAIL: 'x1', FAKE_CLOSE_SLOW: 'x1', FAKE_BETWEEN: '4' }
const PREPARED = ['--set=prepared']
const GROUPED = ['--set=groups']
// The setup's child: 4.5 s, past a variant's deadline (3 s) and within its limit (8 s) and the setup's deadline (15 s).
const CHILD = { FAKE_CHILD: '4500' }
const STEP_KEYS = ['quiet-stall', 'stepped', 'stalled', 'after-stall', 'observed-stall', 'parallel-stall', 'closed']
const STEP_CONTEXTS = {
  'step-named': ['stalled', 'after-stall'],
  'step-observed': ['observed-stall'],
  'step-parallel': ['parallel-stall'],
  'step-reset': ['quiet-stall', 'closed'],
  'step-quiet': ['stepped'],
}

// Only the exported member validator is observed in process. The two outer duplicate-group/CLI cases remain real processes, and the default head keeps all ten native cases.
const declarationAPIOf = (layout) => {
  const file = path.join(layout, 'scripts', 'lib', 'suite-runner.js')
  const localRequire = require('module').createRequire(file)
  let childAttempts = 0
  const guardedRequire = (name) => {
    const loaded = localRequire(name)

    return name === './check-pool' ? { ...loaded, startChild: () => { childAttempts++; throw new HarnessError('a declaration API attempted to start a worker') } } : loaded
  }
  const own = { exports: {} }

  try {
    const factory = nodeVm.runInThisContext('(function (require, __dirname, __filename, module, exports) {\n' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })

    factory(guardedRequire, path.dirname(file), file, own, own.exports)
  } catch (cause) {
    const error = new HarnessError(`the isolated declaration API could not load: ${cause.message}`)

    error.cause = cause
    throw error
  }

  const api = own.exports

  if (typeof api.declaredGroup !== 'function' || typeof api.RunnerError !== 'function') {
    throw new HarnessError('the existing declaration API is unavailable')
  }

  // Read the exact BAD inputs used by the native fixture; no fixture program runs here.
  const text = fs.readFileSync(path.join(layout, 'scripts', 'lib', FIXTURE), 'utf8')
  const definition = acorn.parse(text, { ecmaVersion: 'latest' }).body.filter((node) => node.type === 'VariableDeclaration').flatMap((node) => node.declarations).find((node) => node.id.type === 'Identifier' && node.id.name === 'BAD')
  const literal = (node) => {
    if (node?.type === 'Literal') {
      return node.value
    }

    if (node?.type === 'ArrayExpression') {
      return node.elements.map(literal)
    }

    if (node?.type === 'ObjectExpression' && node.properties.every((part) => part.type === 'Property' && !part.computed && !part.method && part.kind === 'init')) {
      return Object.fromEntries(node.properties.map((part) => [part.key.name || part.key.value, literal(part.value)]))
    }

    throw new HarnessError('the declaration fixture has an unknown input expression')
  }
  const inputs = literal(definition?.init)

  return (name) => {
    if (!Object.hasOwn(inputs, name)) {
      throw new HarnessError(`unknown member declaration input: ${name}`)
    }

    const members = JSON.parse(JSON.stringify(inputs[name]))
    let refused = false
    let refusal = null
    let ruleIdentity = false

    try {
      api.declaredGroup('bad', members)
    } catch (cause) {
      if (!(cause instanceof api.RunnerError)) {
        const error = new HarnessError(`the declaration API threw an unexpected error: ${cause.message}`)

        error.cause = cause
        throw error
      }

      refused = true
      refusal = cause.message
      ruleIdentity = true
    }

    return { observation: 'member-api', refused, refusal, ruleIdentity, childAttempts }
  }
}

// Synchronous declaration data from the actual module before its validation branches. Only two private hooks opt in, one at a time; normal native files and validation stay unchanged.
const listModuleOf = (layout) => {
  const file = path.join(layout, 'scripts', 'lib', 'suite-runner.js')
  const localRequire = require('module').createRequire(file)
  const original = fs.readFileSync(file, 'utf8')
  const names = "  if (__listProbe?.kind === 'solo-names') { __listProbe.value = { kind: 'solo-names', list: list.map(({ key, name }) => ({ key, name })) }; return { list, byKey } }\n"
  const control = "    if (__listProbe?.kind === 'solo-control') { __listProbe.value = { kind: 'solo-control', faultKey: fault?.key ?? null, headKey: head?.key ?? null }; return { list, byKey } }\n"
  const observed = 'let __listProbe = null\n' + patched(RUNNER, patched(RUNNER, original, '  const repeated = list.filter(', names + '  const repeated = list.filter('), '    if (!fault || !head) {', control + '    if (!fault || !head) {') + `
module.exports.observeList = (kind, variants) => {
  if (!['solo-names', 'solo-control'].includes(kind) || __listProbe) { throw new Error('unknown or reentered list observation') }
  const probe = { kind, value: null }
  __listProbe = probe
  try {
    listOf(variants, kind === 'solo-control' ? { fault: 'g', head: 'head' } : null, 3, true)
    if (!probe.value) { throw new Error('the list observation did not reach its hook') }
    return probe.value
  } finally { __listProbe = null }
}
module.exports.defaultList = listOf
`
  const load = (text, filename, requireFor) => {
    const own = { exports: {} }
    const factory = nodeVm.runInThisContext('(function (require, __dirname, __filename, module, exports) {\n' + text + '\n})', { filename })

    factory(requireFor, path.dirname(filename), filename, own, own.exports)

    return own.exports
  }
  const noChild = () => { throw new HarnessError('a declaration observation attempted to run a child') }
  const guardedRequire = (name) => name === './check-pool' ? { ...localRequire(name), startChild: noChild, runChild: noChild } : localRequire(name)

  try {
    const api = load(observed, file, guardedRequire)
    const fixtureFile = path.join(layout, 'scripts', 'lib', FIXTURE)
    const fixture = fs.readFileSync(fixtureFile, 'utf8')
    const call = fixture.lastIndexOf('main().catch(')
    const prefix = fixture.slice(0, call)

    if (call < 0 || !prefix.trim()) {
      throw new HarnessError('the actual group fixture has no removable main call')
    }

    const fixtureRequire = (name) => name === './suite-runner' ? { ...api, runnerArgs: () => api.runnerArgs(['--set=groups']), runSuite: noChild } : guardedRequire(name)
    const { variants } = load(prefix + '\nmodule.exports = { variants: VARIANTS }\n', fixtureFile, fixtureRequire)

    return { api, variants }
  } catch (cause) {
    const error = new HarnessError(`the actual list observation could not load or compute: ${cause.message}`)

    error.cause = cause
    throw error
  }
}

const listValueOf = (seen, kind) => {
  const exact = (object, keys) => object && typeof object === 'object' && Object.keys(object).sort().join(',') === keys.slice().sort().join(',')

  if (kind === 'solo-names') {
    const keys = ['head', 'g/a', 'g/b', 'g/c']

    if (!exact(seen, ['kind', 'list']) || seen.kind !== kind || !Array.isArray(seen.list) || seen.list.length !== keys.length || seen.list.some((entry, at) => !exact(entry, ['key', 'name']) || entry.key !== keys[at] || typeof entry.name !== 'string')) {
      throw new HarnessError('malformed, missing, extra or foreign solo name data')
    }

    const names = seen.list.map(({ name }) => name)
    const unique = new Set(names).size === names.length
    const expected = ['variant head', 'group g, alone: member a', 'group g, alone: member b', 'group g, alone: member c']

    return { correct: unique && names.every((name, at) => name === expected[at]), unique, names }
  }

  if (kind === 'solo-control') {
    if (!exact(seen, ['kind', 'faultKey', 'headKey']) || seen.kind !== kind || ![null, 'g/a'].includes(seen.faultKey) || seen.headKey !== 'head') {
      throw new HarnessError('malformed, missing, extra or foreign solo control data')
    }

    return { correct: seen.faultKey === 'g/a', faultKey: seen.faultKey, headKey: seen.headKey }
  }

  throw new HarnessError('unknown list value observation')
}

const listObservation = (layout, kind) => {
  try {
    const { api, variants } = listModuleOf(layout)
    const data = api.observeList(kind, variants)

    return { data, value: listValueOf(data, kind) }
  } catch (cause) {
    if (cause instanceof HarnessError) {
      throw cause
    }

    const error = new HarnessError(`the actual list computation failed before its value witness: ${cause.message}`)

    error.cause = cause
    throw error
  }
}

const listWitnessObservation = (source) => {
  const definition = acorn.parse(source, { ecmaVersion: 'latest' }).body.filter((node) => node.type === 'VariableDeclaration').flatMap((node) => node.declarations).find((node) => node.id.type === 'Identifier' && node.id.name === 'listValueOf')

  if (!definition) {
    throw new HarnessError('the list witness control found no value oracle')
  }

  const oracle = nodeVm.runInNewContext(`(${source.slice(definition.init.start, definition.init.end)})`, { HarnessError })
  const head = { kind: 'solo-names', list: ['head', 'g/a', 'g/b', 'g/c'].map((key, at) => ({ key, name: ['variant head', 'group g, alone: member a', 'group g, alone: member b', 'group g, alone: member c'][at] })) }
  const copy = () => JSON.parse(JSON.stringify(head))
  const duplicate = copy()

  duplicate.list.slice(1).forEach((entry) => { entry.name = 'group g' })
  const control = { kind: 'solo-control', faultKey: 'g/a', headKey: 'head' }
  const missingControl = { ...control, faultKey: null }
  const rejected = []
  const bads = {
    missing: (data) => { delete data.list },
    extra: (data) => { data.extra = true },
    foreignHook: (data) => { data.kind = 'solo-control' },
    missingRow: (data) => { data.list.pop() },
    extraRow: (data) => { data.list.push({ key: 'g/d', name: 'member d' }) },
    duplicateKey: (data) => { data.list[2].key = 'g/a' },
    foreignKey: (data) => { data.list[2].key = 'foreign' },
    extraField: (data) => { data.list[2].extra = true },
    missingField: (data) => { delete data.list[2].name },
    malformed: (data) => { data.list[2].name = null },
  }

  for (const [name, change] of Object.entries(bads)) {
    const data = copy()

    change(data)
    try {
      oracle(data, 'solo-names')
      rejected.push({ name, rejected: false })
    } catch (error) {
      if (!(error instanceof HarnessError)) {
        throw error
      }

      rejected.push({ name, rejected: true })
    }
  }

  for (const [name, data] of [['extraControl', { ...control, extra: true }], ['missingControlField', { kind: 'solo-control', headKey: 'head' }], ['foreignControl', { ...control, faultKey: 'foreign' }]]) {
    try {
      oracle(data, 'solo-control')
      rejected.push({ name, rejected: false })
    } catch (error) {
      if (!(error instanceof HarnessError)) {
        throw error
      }

      rejected.push({ name, rejected: true })
    }
  }

  return { head: oracle(head, 'solo-names'), duplicate: oracle(duplicate, 'solo-names'), control: oracle(control, 'solo-control'), missingControl: oracle(missingControl, 'solo-control'), rejected }
}

// The public child API as values: actual module code, actual timer callback and result conversion, with one tightly owned in-memory child. Real elapsed limits remain covered by unchanged native heads.
const childAPIObservation = async (source) => {
  const child = new EventEmitter()
  const pid = 1234
  const timers = []
  const kills = []
  let phase = 'starting'
  let spawned = 0
  let problem = null
  const invalid = (message) => {
    problem = new HarnessError(message)
    throw problem
  }
  const kill = (target) => {
    if (target !== pid) {
      invalid('the child API tried to kill a foreign controlled process')
    }

    kills.push({ pid: target, phase })
  }

  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding = (encoding) => {
      if (encoding !== 'utf8') {
        invalid('the child API requested an unknown stream encoding')
      }

      return stream
    }
  }

  const spawn = (program, args, options) => {
    spawned++
    if (spawned !== 1 || program !== process.execPath || JSON.stringify(args) !== JSON.stringify(['controlled-child.js', '--sleep=60000']) || options.env.CHECK_JOBS !== '1' || options.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH !== '0') {
      invalid('the child API attempted an unexpected process or environment')
    }

    return child
  }
  const spawnSync = (program, args) => {
    if (program !== 'taskkill' || JSON.stringify(args) !== JSON.stringify(['/pid', String(pid), '/T', '/F'])) {
      invalid('the child API attempted an unexpected native process operation')
    }

    kill(pid)

    return { status: 0 }
  }
  const setTimeout = (fire, ms) => {
    if (typeof fire !== 'function' || !Number.isFinite(ms) || ms <= 0 || timers.length) {
      invalid('the child API registered an invalid or extra timer')
    }

    const timer = { fire, ms, cleared: false }

    timers.push(timer)

    return timer
  }
  const clearTimeout = (timer) => {
    if (!timer) {
      return
    }

    if (!timers.includes(timer)) {
      invalid('the child API cleared a foreign timer')
    }

    timer.cleared = true
  }
  const own = { exports: {} }
  const requireFor = (name) => {
    if (name === 'os') {
      return require('os')
    }

    if (name === 'child_process') {
      return { spawn, spawnSync }
    }

    return invalid(`the child API requested an unexpected module ${name}`)
  }

  try {
    const factory = nodeVm.runInThisContext('(function (require, module, process, setTimeout, clearTimeout) {\n' + source + '\n})')

    factory(requireFor, own, { platform: process.platform, execPath: process.execPath, env: {}, kill }, setTimeout, clearTimeout)
    if (typeof own.exports.startChild !== 'function') {
      throw new HarnessError('the actual public child API is unavailable')
    }

    const handle = own.exports.startChild('controlled-child.js', ['--sleep=60000'], { limit: 8000 })

    if (handle.pid !== pid) {
      invalid('the public child handle does not own the controlled process')
    }

    if (timers.length) {
      phase = 'timer'
      timers[0].fire()
    } else {
      phase = 'cleanup'
      handle.kill()
    }

    phase = 'closing'
    child.stdout.emit('data', 'the controlled child ended\n')
    child.emit('close', 0)
    const result = await handle.done

    if (problem || spawned !== 1) {
      throw problem || new HarnessError('the child API did not create exactly one controlled child')
    }

    return { kind: 'child-api', registered: timers.map(({ ms }) => ms), killedByTimer: kills.some((event) => event.phase === 'timer'), result, spawnPID: pid, closed: true }
  } catch (cause) {
    if (cause instanceof HarnessError) {
      throw cause
    }

    const error = new HarnessError(`the actual child API observation failed: ${cause.message}`)

    error.cause = cause
    throw error
  }
}

const childValueOf = (seen) => {
  const exact = (object, keys) => object && typeof object === 'object' && Object.keys(object).sort().join(',') === keys.slice().sort().join(',')

  if (!exact(seen, ['kind', 'registered', 'killedByTimer', 'result', 'spawnPID', 'closed']) || seen.kind !== 'child-api' || seen.spawnPID !== 1234 || seen.closed !== true || typeof seen.killedByTimer !== 'boolean' || !Array.isArray(seen.registered) || seen.registered.length > 1 || seen.registered.some((ms) => !Number.isFinite(ms) || ms <= 0) || !exact(seen.result, ['code', 'stdout', 'stderr', 'timedOut']) || typeof seen.result.stdout !== 'string' || typeof seen.result.stderr !== 'string' || typeof seen.result.timedOut !== 'boolean' || (seen.result.code !== null && !Number.isInteger(seen.result.code))) {
    throw new HarnessError('malformed, extra, incomplete or foreign child API data')
  }

  return { correct: seen.registered.length === 1 && seen.registered[0] === 8000 && seen.killedByTimer && seen.result.timedOut && seen.result.code === null && seen.result.stderr.endsWith('the child did not finish in 8 s\n') }
}

const childWitnessObservation = async (source, poolSource) => {
  const definition = acorn.parse(source, { ecmaVersion: 'latest' }).body.filter((node) => node.type === 'VariableDeclaration').flatMap((node) => node.declarations).find((node) => node.id.type === 'Identifier' && node.id.name === 'childValueOf')

  if (!definition) {
    throw new HarnessError('the child witness control found no value oracle')
  }

  const oracle = nodeVm.runInNewContext(`(${source.slice(definition.init.start, definition.init.end)})`, { HarnessError })
  const head = await childAPIObservation(poolSource)
  const copy = () => JSON.parse(JSON.stringify(head))
  const missing = copy()

  missing.registered = []
  missing.killedByTimer = false
  const late = copy()

  late.result.timedOut = false
  late.result.code = 0
  const rejected = []
  const bads = {
    missing: (data) => { delete data.result },
    extra: (data) => { data.extra = true },
    foreignKind: (data) => { data.kind = 'foreign' },
    foreignPID: (data) => { data.spawnPID++ },
    unfinished: (data) => { data.closed = false },
    extraTimer: (data) => { data.registered.push(8000) },
    malformedTimer: (data) => { data.registered[0] = null },
    missingResult: (data) => { delete data.result.timedOut },
    extraResult: (data) => { data.result.error = 'EIO' },
  }

  for (const [name, change] of Object.entries(bads)) {
    const data = copy()

    change(data)
    try {
      oracle(data)
      rejected.push({ name, rejected: false })
    } catch (error) {
      if (!(error instanceof HarnessError)) {
        throw error
      }

      rejected.push({ name, rejected: true })
    }
  }

  return { head: oracle(head), missing: oracle(missing), late: oracle(late), rejected }
}

const observationContexts = (profile, file, from, original, needs, checks) => {
  if (profile === null) {
    return {}
  }

  if (profile === 'finite-failures') {
    const anchors = [': list\n  const args = ', 'checks: 1, failures: 1, extra: {}, harness: reason', 'if (harness && !own) {']

    if (file !== RUNNER || !anchors.includes(from) || needs.length !== 1 || needs[0] !== 'all' || checks.length !== 1 || !['order', 'totals'].includes(checks[0])) {
      throw new HarnessError('unknown finite-failure observation mapping')
    }

    return { all: 'finite-failures' }
  }

  if (profile === 'child-api') {
    if (file !== POOL || !['const timer = limit ? setTimeout(', '    timedOut = true\n'].includes(from) || needs.length !== 1 || needs[0] !== 'prepared' || checks.length !== 1 || checks[0] !== 'child-limit') {
      throw new HarnessError('unknown public child API observation mapping')
    }

    return { prepared: 'child-api' }
  }

  if (['solo-names', 'solo-control'].includes(profile)) {
    const names = profile === 'solo-names'
    const need = names ? 'solo' : 'groupControl'
    const id = names ? 'solo-run' : 'group-control'
    // eslint-disable-next-line no-template-curly-in-string
    const anchor = names ? 'name: `${variant.name}, alone: ${member.name}`' : 'byKey.get(control.fault) || byKey.get(first.get(control.fault))'

    if (file !== RUNNER || from !== anchor || needs.length !== 1 || needs[0] !== need || checks.length !== 1 || checks[0] !== id) {
      throw new HarnessError('unknown actual-list fault mapping')
    }

    return { [need]: profile }
  }

  if (profile === 'close-arm') {
    const anchors = ["arm(between, 'the close of the worker')", "    say('closing')\n"]

    if (file !== RUNNER || !anchors.includes(from) || !needs.includes('closing') || !needs.includes('setupClose') || checks.length !== 2 || !checks.includes('closing') || !checks.includes('setup-close')) {
      throw new HarnessError('unknown close-arm fault mapping')
    }

    return { closing: 'close-arm', setupClose: 'close-arm' }
  }

  if (profile !== 'declared-member-api' || file !== RUNNER || !needs.includes('declared') || !checks.includes('group-declared')) {
    throw new HarnessError('unknown fault observation profile')
  }

  const declared = acorn.parse(original, { ecmaVersion: 'latest' }).body.filter((node) => node.type === 'VariableDeclaration').flatMap((node) => node.declarations).find((node) => node.id.type === 'Identifier' && node.id.name === 'declaredGroup')
  const begin = original.indexOf(from)
  const inMemberAPI = declared && begin >= declared.init.start && begin + from.length <= declared.init.end
  const outerDuplicate = from === 'variants.map(({ key }) => key).filter((key, at, all) => all.indexOf(key) !== at)'

  if (begin < 0 || (!inMemberAPI && !outerDuplicate)) {
    throw new HarnessError('a CLI/serialization fault cannot be projected onto the member API')
  }

  return { declared: 'member-api' }
}

const SCENARIOS = {
  deadlineClock: (source) => deadlineClockObservation(source),
  closeArmWitness: (source) => closeArmObservation(source),
  listWitness: (source) => listWitnessObservation(source),
  childWitness: (source, poolSource) => childWitnessObservation(source, poolSource),
  all: (layout, checks = null, context = null) => {
    if (context !== null && (context !== 'finite-failures' || !checks?.length || checks.some((id) => !['order', 'totals'].includes(id)))) {
      throw new HarnessError('unknown order/count fixture mapping')
    }

    const selected = { thrown: ['throw', 'after-throw'], crash: ['crash', 'after-crash'], control: ['control:warm-reset'] }
    const small = checks !== null && checks.every((id) => Object.hasOwn(selected, id))
    const variants = small ? Object.entries(selected).filter(([id]) => checks.includes(id)).flatMap(([, keys]) => keys) : []

    return runIn(layout, ['--set=all', ...(small ? [`--variants=${variants.join(',')}`] : [])], { observeDeadline: checks?.length === 1 && checks[0] === 'deadline' }).then((run) => ({ ...run, ledger: ledgerOf(layout), record: recordOf(layout) }))
  },
  leaky: (layout) => runIn(layout, ['--set=all', '--variants=control:warm-reset'], { env: { FAKE_LEAKY: '1' } }),
  control: (layout) => runIn(layout, ['--set=control'], { env: { FAKE_RESET_FAIL: 'control:warm-reset' } }),
  late: (layout) => runIn(layout, ['--set=late']).then((run) => ({ ...run, record: recordOf(layout) })),
  closing: async (layout, checks = null, context = null) => {
    if (context !== null && (context !== 'close-arm' || !checks?.includes('closing'))) {
      throw new HarnessError('unknown closing criterion/arm mapping')
    }

    const first = await runIn(layout, ['--set=closing'], { env: CLOSING, observeClose: context === 'close-arm' ? 'closing' : null })
    const resumed = first.closeArm?.earlyStopped ? null : await runIn(layout, ['--set=closing', '--resume'], { env: CLOSING })

    return { first, resumed }
  },
  deaths: (layout) => runIn(layout, ['--set=deaths']).then((run) => ({ ...run, ledger: ledgerOf(layout) })),
  interrupted: async (layout) => {
    const stopped = await runIn(layout, ['--set=closing'], { env: { FAKE_CLOSE_FAIL: '1' }, stopAt: 'closing' })
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
  setupClose: (layout, checks = null, context = null) => {
    if (context !== null && (context !== 'close-arm' || !checks?.includes('setup-close'))) {
      throw new HarnessError('unknown setup-close criterion/arm mapping')
    }

    return runIn(layout, ['--set=closing'], { env: { FAKE_SETUP_FAIL: '1', FAKE_CLOSE_SLOW: 'x1', FAKE_BETWEEN: '4' }, observeClose: context === 'close-arm' ? 'setupClose' : null }).then((run) => ({ ...run, ledger: ledgerOf(layout) }))
  },
  resume: async (layout, checks = null) => {
    const known = ['resume-skips', 'resume-again', 'resume-torn', 'refuse-list', 'refuse-inputs', 'refuse-tree']

    if (checks !== null && checks.some((id) => !known.includes(id))) {
      throw new HarnessError(`unknown resume observation mapping: ${checks.join(', ')}`)
    }

    const wants = (id) => checks === null || checks.includes(id)
    const seen = { ledgers: {} }

    if (wants('resume-skips')) {
      seen.stopped = await runIn(layout, ['--set=resume'], { stopAt: 'r4' })
      seen.resumed = await runIn(layout, RESUME)
      seen.ledgers.resumed = ledgerOf(layout)
    } else {
      // The refusal/torn contracts start with a complete independent record; they do not need an unrelated interruption, second resume or another refusal first.
      seen.seed = await runIn(layout, ['--set=resume'])
      ran(seen.seed, 'the complete-record dependency')

      if (seen.seed.code !== 0 || totalsOf(seen.seed.stdout) !== '6 of 6' || harnessOf(seen.seed.stdout).length) {
        throw new HarnessError('the resume observation could not prepare a valid complete-record dependency')
      }
    }

    if (wants('resume-again')) {
      seen.again = await runIn(layout, RESUME)
    }

    if (wants('resume-torn')) {
      tear(layout)
      seen.torn = await runIn(layout, RESUME)
      seen.tornRecord = recordIntegrityOf(layout)
      // The named criterion checks bad bytes first; a known corrupt record must not become a second crash-only observation.
      seen.tornAgain = seen.tornRecord.valid ? await runIn(layout, RESUME) : null
      seen.ledgers.torn = ledgerOf(layout)
    }

    if (wants('refuse-list')) {
      seen.listed = await runIn(layout, RESUME, { env: { FAKE_EXTRA: '1' } })
    }

    if (wants('refuse-inputs')) {
      const save = path.join(layout, 'saves', 'input.db')
      const written = fs.statSync(save)

      fs.writeFileSync(save, 'b save\n')
      fs.utimesSync(save, written.atime, written.mtime)
      seen.saved = await runIn(layout, RESUME)
    }

    if (wants('refuse-tree')) {
      fs.writeFileSync(path.join(layout, 'src', 'one.js'), 'module.exports = 2\n')
      seen.changed = await runIn(layout, RESUME)
    }

    return seen
  },
  steps: async (layout, checks = null) => {
    if (checks !== null && checks.some((id) => !Object.hasOwn(STEP_CONTEXTS, id))) {
      throw new HarnessError(`unknown step observation mapping: ${checks.join(', ')}`)
    }

    const selected = checks === null ? STEP_KEYS : STEP_KEYS.filter((key) => checks.some((id) => STEP_CONTEXTS[id].includes(key)))
    const run = await runIn(layout, ['--set=steps', ...(checks === null ? [] : [`--variants=${selected.join(',')}`])], { env: { FAKE_CLOSE_SLOW: 'closed', FAKE_BETWEEN: '4' } })

    return { ...run, selected }
  },
  repeated: async (layout) => {
    const run = await runIn(layout, REPEAT)
    const record = recordOf(layout)
    const ledger = ledgerOf(layout)

    tear(layout)

    const resumed = await runIn(layout, [...REPEAT, '--resume'])

    return { ...run, record, ledger, resumed, resumedLedger: ledgerOf(layout).slice(ledger.length) }
  },
  prepared: async (layout, checks = null, context = null) => {
    if (checks !== null && checks.some((id) => !['prepare-first', 'prepare-resumed', 'prepare-lazy', 'child-limit'].includes(id))) {
      throw new HarnessError(`unknown prepared observation mapping: ${checks.join(', ')}`)
    }

    if (context !== null && (context !== 'child-api' || checks?.length !== 1 || checks[0] !== 'child-limit')) {
      throw new HarnessError('unknown child-limit API mapping')
    }

    const wants = (id) => checks === null || checks.includes(id)
    const seen = {}

    if (context === 'child-api') {
      const data = await childAPIObservation(fs.readFileSync(path.join(layout, 'scripts', 'lib', 'check-pool.js'), 'utf8'))

      seen.childAPI = { data, value: childValueOf(data) }
      if (!seen.childAPI.value.correct) {
        return seen
      }
    }

    // The head keeps every real deadline comparison. A fault runs the complete observation required by its own named check, without repeating the other independent preparations.
    if (wants('prepare-resumed')) {
      seen.whole = await runIn(layout, PREPARED, { env: CHILD })
      const ledger = ledgerOf(layout)

      tear(layout)
      seen.resumed = await runIn(layout, [...PREPARED, '--resume'], { env: CHILD })
      seen.resumedLedger = ledgerOf(layout).slice(ledger.length)
    }

    if (wants('prepare-first')) {
      seen.first = await runIn(layout, [...PREPARED, '--variants=p2'], { env: CHILD })
    }

    if (wants('prepare-lazy')) {
      seen.lazy = await runIn(layout, [...PREPARED, '--variants=p2'], { env: { ...CHILD, FAKE_LAZY: '1' } })
    }

    if (wants('child-limit')) {
      seen.limited = await runIn(layout, [...PREPARED, '--variants=p1'], { env: { FAKE_CHILD: '60000' } })
    }

    return seen
  },
  racing: (layout) => runIn(layout, [...PREPARED, '--variants=p1'], { env: { FAKE_CHILD: '3000', FAKE_LIMIT: '2000' } }),
  grouped: async (layout) => {
    const run = await runIn(layout, GROUPED)
    const record = recordOf(layout)
    const ledger = ledgerOf(layout)

    tear(layout)

    const resumed = await runIn(layout, [...GROUPED, '--resume'])

    return { ...run, record, ledger, resumed, resumedLedger: ledgerOf(layout).slice(ledger.length) }
  },
  solo: async (layout, checks = null, context = null) => {
    if (context !== null && (context !== 'solo-names' || !checks?.includes('solo-run'))) {
      throw new HarnessError('unknown solo-name observation mapping')
    }

    const declaration = context ? listObservation(layout, context) : null

    if (declaration && !declaration.value.correct) {
      return { declaration }
    }

    const run = await runIn(layout, [...GROUPED, '--solo'])
    const record = recordOf(layout)
    const ledger = ledgerOf(layout)
    const grouped = await runIn(layout, [...GROUPED, '--resume'])
    const one = await runIn(layout, [...GROUPED, '--solo', '--variants=g/b'])

    return { run, record, ledger, grouped, one, oneLedger: ledgerOf(layout).slice(ledger.length), ...(declaration ? { declaration } : {}) }
  },
  selected: async (layout) => {
    const grouped = await runIn(layout, [...GROUPED, '--only=member b']).then((run) => ({ ...run, ledger: ledgerOf(layout) }))
    const solo = await runIn(layout, [...GROUPED, '--only=member b', '--solo']).then((run) => ({ ...run, ledger: ledgerOf(layout).slice(grouped.ledger.length) }))
    const named = await runIn(layout, [...GROUPED, '--variants=g']).then((run) => ({ ...run, ledger: ledgerOf(layout).slice(grouped.ledger.length + solo.ledger.length) }))

    return { grouped, solo, named }
  },
  groupControl: async (layout, checks = null, context = null) => {
    if (context !== null && (context !== 'solo-control' || !checks?.includes('group-control'))) {
      throw new HarnessError('unknown solo-control observation mapping')
    }

    const declaration = context ? listObservation(layout, context) : null

    if (declaration && !declaration.value.correct) {
      return { declaration }
    }

    return { grouped: await runIn(layout, ['--set=groups-control']), solo: await runIn(layout, ['--set=groups-control', '--solo']), ...(declaration ? { declaration } : {}) }
  },
  groupHang: async (layout) => ({ grouped: await runIn(layout, GROUPED, { env: { FAKE_GROUP_HANG: 'b' } }), solo: await runIn(layout, [...GROUPED, '--solo'], { env: { FAKE_GROUP_HANG: 'b' } }) }),
  declared: async (layout, checks = null, context = null) => {
    if (context !== null && (context !== 'member-api' || checks?.length !== 1 || checks[0] !== 'group-declared')) {
      throw new HarnessError('unknown declaration criterion/API mapping')
    }

    const runs = {}
    const api = context === 'member-api' ? declarationAPIOf(layout) : null

    for (const what of ['overlap', 'lone', 'twin-key', 'twin-name', 'mixed', 'slash', 'nameless', 'unlisted']) {
      runs[what] = api ? api(what) : { ...await runIn(layout, ['--set=declared'], { env: { FAKE_GROUP: what } }), started: ledgerOf(layout).length }
    }

    // These exercise the outer list/CLI path and never use declaredGroup as a substitute.
    runs['twin-group'] = { ...await runIn(layout, ['--set=declared'], { env: { FAKE_GROUP: 'twin-group' } }), started: ledgerOf(layout).length }
    runs['twin-group-solo'] = { ...await runIn(layout, ['--set=declared', '--solo'], { env: { FAKE_GROUP: 'twin-group' } }), started: ledgerOf(layout).length }

    return runs
  },
  widthDefault: (layout) => widthRun(layout, ['--set=resume'], { CHECK_JOBS: '2' }),
  widthExplicit: async (layout, checks = null) => {
    if (checks !== null && checks.some((id) => !['width-explicit', 'width-same'].includes(id))) {
      throw new HarnessError(`unknown width observation mapping: ${checks.join(', ')}`)
    }

    const seen = {}

    // The run in one worker is what the run at a width is compared with, and only that comparison needs it.
    if (checks === null || checks.includes('width-same')) {
      seen.one = await widthRun(layout, ['--set=resume'])
    }

    seen.wide = await widthRun(layout, ['--set=resume'], { FAKE_WORKERS: '3' })

    return seen
  },
  widthCap: (layout) => widthRun(layout, ['--set=resume'], { FAKE_WORKERS: '3', FAKE_THREADS: '4' }),
  widthOrdered: (layout) => widthRun(layout, ['--set=resume', '--variants=r3,r1,r2'], { FAKE_WORKERS: '3' }),
  widthDeaths: (layout) => widthRun(layout, ['--set=wide'], { FAKE_WORKERS: '2' }),
  widthInvalid: async (layout, checks = null) => {
    const named = { 'width-zero': '0', 'width-text': '"x"', 'width-fraction': '2.5', 'width-negative': '-2' }

    if (checks !== null && checks.some((id) => !Object.hasOwn(named, id))) {
      throw new HarnessError(`unknown width observation mapping: ${checks.join(', ')}`)
    }

    const seen = {}

    for (const [id, width] of Object.entries(named)) {
      if (checks === null || checks.includes(id)) {
        seen[id] = await widthRun(layout, ['--set=resume'], { CHECK_JOBS: '2', FAKE_WORKERS: width })
      }
    }

    return seen
  },
}

const observe = async (sources, needs, checks = null, contexts = {}) => {
  if (Object.entries(contexts).some(([need, mode]) => !needs.includes(need) || !((need === 'declared' && mode === 'member-api' && checks?.includes('group-declared')) || (need === 'all' && mode === 'finite-failures' && checks?.length && checks.every((id) => ['order', 'totals'].includes(id))) || (need === 'prepared' && mode === 'child-api' && checks?.length === 1 && checks[0] === 'child-limit') || (need === 'solo' && mode === 'solo-names' && checks?.includes('solo-run')) || (need === 'groupControl' && mode === 'solo-control' && checks?.includes('group-control')) || (['closing', 'setupClose'].includes(need) && mode === 'close-arm' && checks?.includes(need === 'closing' ? 'closing' : 'setup-close'))))) {
    throw new HarnessError('unknown declaration API observation context')
  }

  if (needs.some((need) => !Object.hasOwn(SCENARIOS, need))) {
    throw new HarnessError(`unknown observation context: ${needs.join(', ')}`)
  }

  if (checks !== null && checks.some((id) => !CHECKS.some(([known, required]) => known === id && required.every((need) => needs.includes(need))))) {
    throw new HarnessError(`unknown check/context mapping: ${checks.join(', ')} over ${needs.join(', ')}`)
  }

  const seen = {}

  for (const need of needs) {
    const selected = checks === null ? null : checks.filter((id) => CHECKS.find(([known]) => known === id)[1].includes(need))

    seen[need] = await inLayout(sources, need, selected?.length ? selected : null, contexts[need] || null)
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
  if (!run || run.error || run.timedOut || (!/^HARNESS \[.*\]$/m.test(run.stdout) && !/^(?:error|Error): --resume: /m.test(run.stderr))) {
    throw new HarnessError(`${what} did not produce a complete fixture result: ${run?.error || (run?.timedOut ? 'the outer safety watchdog expired' : run?.stderr?.trim().split('\n').slice(-3).join(' | ')) || 'no result'}`)
  }
}
// Invalid widths must be judged only after the fixture returned normally with every result. Missing workers after a crash are not an observed fallback width.
const fellBack = (run, what) => {
  ran(run, what)
  const keys = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']

  if (run.code !== 0 || run.stderr.trim() || totalsOf(run.stdout) !== '6 of 6' || harnessOf(run.stdout).length || printed(run.stdout).join(',') !== keys.join(',') || run.rows !== keys.length || Object.keys(run.record).sort().join(',') !== keys.join(',') || keys.some((key) => {
    const result = run.record[key]

    return result.key !== key || result.checks !== 1 || result.failures !== 0 || result.harness || result.problem || !Array.isArray(result.output) || !result.output.includes(`PASS  ${key}`)
  })) {
    throw new HarnessError(`${what} did not return normal totals and a complete six-variant record; no invalid-width fault can be credited`)
  }

  assert.equal(run.workers.peak, 2, `${what} used ${run.workers.peak} workers side by side, expected CHECK_JOBS=2`)
  assert.deepStrictEqual(run.workers.queues, ['r1,r3,r5', 'r2,r4,r6'])
}
const harnessHas = (run, key, start) => assert.ok(harnessOf(run.stdout).some((line) => line.startsWith(`${key}: ${start}`)), `no defect of the harness ${key}: ${start}… in ${JSON.stringify(harnessOf(run.stdout))}`)
const problemOf = (run, start) => assert.ok(harnessOf(run.stdout).some((line) => line.startsWith(start)), `no defect of the run ${start}… in ${JSON.stringify(harnessOf(run.stdout))}`)
const harnessIs = (run, line) => assert.ok(harnessOf(run.stdout).includes(line), `no defect of the harness "${line}" in ${JSON.stringify(harnessOf(run.stdout))}`)
// The line of stderr that says why a run would not resume: its message, not a line of the source the runtime prints around the throw (which can hold the message of another refusal).
const refusalOf = (run) => run.stderr.split('\n').find((line) => line.includes('--resume: ') && !/^\s*\d+\s*\|/.test(line)) || ''

// [id, scenarios it needs, what it holds, the assertions over what they saw]
const checkCloseArm = (run) => {
  if (!run.closeArm) {
    return
  }

  const seen = run.closeArm

  if (!seen.cleaned || !seen.ownedHandlePending) {
    throw new HarnessError('an invalid close-arm observation cannot earn fault credit')
  }

  assert.equal(seen.correct, true, `the close bound was ${seen.delay === null ? 'not armed' : `${seen.delay} ms by ${seen.dispatch}`}, expected 4000 ms by this closing dispatch`)
}

const CHECKS = [
  ['child-api-witness', ['childWitness'], 'the actual public child API registers its bound and reports its timer callback as a timeout, while malformed or foreign event data earns no credit', ({ childWitness }) => {
    assert.equal(childWitness.head.correct, true)
    assert.equal(childWitness.missing.correct, false, 'a child with no timer was accepted as bounded')
    assert.equal(childWitness.late.correct, false, 'a child completion after its timer callback was accepted as on time')
    assert.equal(childWitness.rejected.length, 9)
    assert.ok(childWitness.rejected.every(({ rejected }) => rejected), 'malformed child API data was accepted')
  }],
  ['list-witness', ['listWitness'], 'actual solo declaration data is judged by independent names and control keys, and malformed, extra, missing or foreign hook data cannot earn credit', ({ listWitness }) => {
    assert.equal(listWitness.head.correct, true)
    assert.equal(listWitness.duplicate.correct, false, 'duplicate solo names were accepted as valid data')
    assert.equal(listWitness.control.correct, true)
    assert.equal(listWitness.missingControl.correct, false)
    assert.equal(listWitness.rejected.length, 13)
    assert.ok(listWitness.rejected.every(({ rejected }) => rejected), 'malformed list hook data was accepted')
  }],
  ['close-arm-witness', ['closeArmWitness'], 'a close bound belongs to this run and worker closing dispatch, and stale, early, unrelated or expired witnesses cannot earn credit', ({ closeArmWitness }) => {
    assert.equal(closeArmWitness.head.correct, true)
    assert.equal(closeArmWitness.setup.correct, true)
    assert.equal(closeArmWitness.wrongDispatch.correct, false, 'a timer from the end of a variant was accepted as the close bound')
    assert.equal(closeArmWitness.missing.correct, false)
    assert.equal(closeArmWitness.wrongBound.correct, false)
    assert.equal(closeArmWitness.rejected.length, 14)
    assert.ok(closeArmWitness.rejected.every(({ rejected }) => rejected), 'an invalid close witness was accepted')
  }],
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
    if (all.deadline?.overdue) {
      const seen = all.deadline

      if (!seen.alive || !seen.cleaned || !seen.ownedHandlePending || !Number.isInteger(seen.pid) || !Number.isFinite(seen.observed) || !Number.isFinite(seen.parentObserved) || !Number.isFinite(seen.witnessed) || seen.observed - seen.parentObserved < DEADLINE_UPPER_MS || seen.parentObserved > seen.witnessed || seen.witnessed > seen.observed) {
        throw new HarnessError('the overdue worker has no complete readiness, lifetime and cleanup witness')
      }

      assert.equal(all.deadline.overdue, false, `the ready worker ${all.deadline.pid} remained alive past the existing 10 s upper bound and was then cleaned up`)
    }

    ran(all, 'the suite')

    for (const key of ['hang', 'spin']) {
      harnessHas(all, key, `the variant ${key} did not finish in 3 s`)
      assert.ok(all.record[key] && all.record[key].seconds >= 3 && all.record[key].seconds < 10, `${key} ended after ${all.record[key] && all.record[key].seconds} s`)
      assert.notEqual(pidOf(all.ledger, `after-${key}`), pidOf(all.ledger, key), `the variant after ${key} ran in a fresh worker`)
    }
  }],
  ['deadline-clock', ['deadlineClock'], 'a delayed parent begin uses its own elapsed clock: an old worker phase is not credited as an overdue deadline', ({ deadlineClock }) => {
    assert.equal(deadlineClock.early, false, 'an old worker phase fabricated a breach of the fresh parent deadline')
    assert.equal(deadlineClock.laterOverdue, true)
    assert.ok(deadlineClock.parentElapsed >= DEADLINE_UPPER_MS, `the parent was only ${deadlineClock.parentElapsed} ms past begin`)
    assert.equal(deadlineClock.cleaned, true)
    assert.equal(deadlineClock.killed, 1)
  }],
  ['thrown', ['all'], 'an error a variant throws fails it by name as a defect of the harness, and its worker goes on with the next', ({ all }) => {
    ran(all, 'the suite')
    harnessHas(all, 'throw', 'a defect of the harness planted')
    assert.equal(pidOf(all.ledger, 'after-throw'), pidOf(all.ledger, 'throw'))
  }],
  ['crash', ['all'], 'a worker that ends in the middle of a variant fails that variant by name, and the next runs in a fresh worker', ({ all }) => {
    ran(all, 'the suite')
    harnessHas(all, 'crash', 'the worker ended with status 9')
    assert.ok(pidOf(all.ledger, 'crash') && pidOf(all.ledger, 'after-crash'), 'both the crashed variant and the following variant ran')
    assert.ok(/^PASS {2}after-crash$/m.test(all.stdout), 'the variant after the crash passed')
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
    checkCloseArm(closing.first)
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
    assert.equal(interrupted.stopped.stoppedAt.phase, 'closing')
    assert.notEqual(interrupted.stopped.run, interrupted.resumed.run, 'a resumed fixture inherited the previous run identity')
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
    checkCloseArm(setupClose)
    ran(setupClose, 'the suite whose setup fails and whose close is slow')

    for (const key of ['x1', 'x2']) {
      harnessIs(setupClose, `${key}: not run: the setup failed: a setup planted to fail; the close of the worker did not finish in 4 s`)
    }

    assert.equal(setupClose.ledger.length, 0)
    assert.equal(setupClose.code, 2)
  }],
  ['resume-skips', ['resume'], 'a run ended in the middle of a variant and resumed runs only the variants not recorded, prints every variant in order, and its totals are those of a whole run', ({ resume }) => {
    assert.equal(resume.stopped.stoppedAt.phase, 'r4')
    assert.notEqual(resume.stopped.run, resume.resumed.run, 'a resumed fixture inherited the previous run identity')
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
    assert.equal(resume.tornRecord.valid, true, resume.tornRecord.detail)
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
  ['step-named', ['steps'], 'a variant past its deadline is named with the last step it said and the run goes on', ({ steps }) => {
    ran(steps, 'the suite whose variant says its steps')
    harnessIs(steps, 'stalled: the variant stalled did not finish in 3 s; the last step it reached: picking the game')
    assert.ok(/^PASS {2}after-stall$/m.test(steps.stdout), 'after-stall passed')
  }],
  ['step-observed', ['steps'], 'a variant past its deadline is named with the last step of its observation', ({ steps }) => {
    ran(steps, 'the suite whose observation says its steps')
    harnessIs(steps, 'observed-stall: the variant observed-stall did not finish in 3 s; the last step it reached: reading the fake page')
  }],
  ['step-parallel', ['steps'], 'a variant past its deadline keeps the step of an observation still open when its sibling ends', ({ steps }) => {
    ran(steps, 'the suite whose observations overlap')
    harnessIs(steps, 'parallel-stall: the variant parallel-stall did not finish in 3 s; the last step it reached: waiting for the stalled observation')
  }],
  ['step-reset', ['steps'], 'a deadline names only a step said since its variant began: none for a variant that said none after a setup that said one, none for a close after a variant that said one', ({ steps }) => {
    ran(steps, 'the suite whose variants say their steps')
    harnessIs(steps, 'quiet-stall: the variant quiet-stall did not finish in 3 s')
    harnessIs(steps, 'a worker ended badly after the variant closed: the close of the worker did not finish in 4 s')
  }],
  ['step-quiet', ['steps'], 'no step reaches the output, nor one said outside a worker: the variants print their own lines in order and the totals count each once', ({ steps }) => {
    ran(steps, 'the suite whose variants say their steps')
    if (!Array.isArray(steps.selected) || !steps.selected.length || new Set(steps.selected).size !== steps.selected.length || steps.selected.some((key) => !STEP_KEYS.includes(key))) {
      throw new HarnessError('the step output has no known, independent fixture expectation')
    }

    assert.ok(!steps.stdout.includes('@@suite-runner'), steps.stdout.split('\n').find((line) => line.includes('@@suite-runner')))
    assert.deepStrictEqual(printed(steps.stdout), steps.selected)
    const passing = steps.selected.filter((key) => ['stepped', 'after-stall', 'closed'].includes(key)).length

    assert.equal(totalsOf(steps.stdout), `${passing} of ${steps.selected.length}`)
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
    if (prepared.childAPI) {
      assert.equal(prepared.childAPI.value.correct, true, `the actual child API returned ${JSON.stringify(prepared.childAPI.data)}`)
    }

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
  ['group-run', ['grouped'], 'a group runs once with all its members, as one variant under the key of the group: its members print their checks in order and the totals count each once', ({ grouped }) => {
    ran(grouped, 'the run of a group')
    assert.deepStrictEqual(printed(grouped.stdout), ['head', 'a', 'b', 'c'])
    assert.equal(totalsOf(grouped.stdout), '4 of 4')
    assert.deepStrictEqual(harnessOf(grouped.stdout), [])
    assert.deepStrictEqual(Object.keys(grouped.record).sort(), ['g', 'head'])
    assert.deepStrictEqual(grouped.ledger.map(([key]) => key), ['head', 'g:a+b+c'], 'the group ran once, handed all its members')
    assert.equal(grouped.code, 0)
  }],
  ['group-resume', ['grouped'], 'a group is resumed by its key: a run whose last line is cut runs the group again, with all its members, and nothing else', ({ grouped }) => {
    ran(grouped.resumed, 'the resumed run')
    assert.ok(/resumed: 1 of 2 variants done/.test(grouped.resumed.stdout), grouped.resumed.stdout.split('\n')[0])
    assert.deepStrictEqual(grouped.resumedLedger.map(([key]) => key), ['g:a+b+c'])
    assert.equal(totalsOf(grouped.resumed.stdout), '4 of 4')
  }],
  ['solo-run', ['solo'], '--solo runs each member of a group alone, as a variant of its own under the key `group/member`, each handed only itself, in the worker the workers of the run are given it', ({ solo }) => {
    if (solo.declaration) {
      assert.equal(solo.declaration.value.correct, true, `the produced solo names were ${JSON.stringify(solo.declaration.data.list)}`)
    }

    ran(solo.run, 'the run with --solo')
    assert.deepStrictEqual(Object.keys(solo.record).sort(), ['g/a', 'g/b', 'g/c', 'head'])
    const names = ['head', 'g/a', 'g/b', 'g/c'].map((key) => solo.record[key].name)

    assert.equal(new Set(names).size, 4, 'each solo variant has its own name')
    assert.deepStrictEqual(names, ['variant head', 'group g, alone: member a', 'group g, alone: member b', 'group g, alone: member c'])
    assert.deepStrictEqual(solo.ledger.map(([key]) => key), ['head', 'g:a', 'g:b', 'g:c'])
    assert.equal(totalsOf(solo.run.stdout), '4 of 4')
    assert.deepStrictEqual(harnessOf(solo.run.stdout), [])
  }],
  ['solo-resume', ['solo'], 'a run with --solo is a run of its own: the record of a grouped run with the same arguments is not there to resume, and the one run alone with --variants is its own', ({ solo }) => {
    ran(solo.grouped, 'the grouped run after it')
    assert.ok(refusalOf(solo.grouped).includes('there is no record of a run with these arguments'), refusalOf(solo.grouped) || solo.grouped.stderr.split('\n')[0])
    assert.notEqual(solo.grouped.code, 0)
  }],
  ['solo-one', ['solo'], '--solo with --variants=group/member runs that member alone', ({ solo }) => {
    ran(solo.one, 'the run of one member')
    assert.deepStrictEqual(solo.oneLedger.map(([key]) => key), ['g:b'])
    assert.equal(totalsOf(solo.one.stdout), '1 of 1')
  }],
  ['group-only', ['selected'], '--only matches the names of the members of a group: it runs the group, handed all its members, and with --solo only the member the text names, beside the head', ({ selected }) => {
    ran(selected.grouped, 'the run of the group by --only')
    assert.deepStrictEqual(selected.grouped.ledger.map(([key]) => key), ['head', 'g:a+b+c'])
    ran(selected.solo, 'the run of one member by --only')
    assert.deepStrictEqual(selected.solo.ledger.map(([key]) => key), ['head', 'g:b'])
    ran(selected.named, 'the run of the group by its key')
    assert.deepStrictEqual(selected.named.ledger.map(([key]) => key), ['g:a+b+c'])
  }],
  ['group-control', ['groupControl'], 'a control that names a group runs it, whole or, with --solo, by the first of its members, and then the head: it passes', ({ groupControl }) => {
    if (groupControl.declaration) {
      assert.equal(groupControl.declaration.value.correct, true, `the solo control resolved ${JSON.stringify(groupControl.declaration.data)}, expected fault g/a and head head`)
    }

    for (const [what, run] of [['the control of a group', groupControl.grouped], ['the control of a group run with --solo', groupControl.solo]]) {
      ran(run, what)
      assert.ok(/^PASS {2}control: .*the fault caught, then the head 1 of 1/m.test(run.stdout), `${what} passed: ${run.stdout.split('\n').find((line) => line.includes('control')) || run.stderr.split('\n')[0]}`)
    }
  }],
  ['group-hang', ['groupHang'], 'a group that hangs fails by name as a defect of the harness, and with --solo only the member run alone that hangs', ({ groupHang }) => {
    ran(groupHang.grouped, 'the run of the group that hangs')
    harnessIs(groupHang.grouped, 'g: the variant g did not finish in 3 s')
    ran(groupHang.solo, 'the run of members alone, one of which hangs')
    assert.deepStrictEqual(harnessOf(groupHang.solo.stdout), ['g/b: the variant g/b did not finish in 3 s'])
    assert.ok(/^PASS {2}a$/m.test(groupHang.solo.stdout) && /^PASS {2}c$/m.test(groupHang.solo.stdout), 'the members beside it passed')
  }],
  ['group-declared', ['declared'], 'a group the runner refuses stops the run before anything starts, by the rule it breaks: too few members, a key that cannot be told apart, no name, no list of checks, a key or a name twice, faults and rewrites together, one check named by two members', ({ declared }) => {
    const says = { overlap: 'the check shared', lone: 'fewer than two members', 'twin-key': 'the same key: a', 'twin-name': 'the same name: member a', mixed: 'all faults or all rewrites', slash: 'a comma, a space, a slash or a hash', nameless: '(b) has no name', unlisted: 'does not list the ids', 'twin-group': 'or a space: bad', 'twin-group-solo': 'or a space: bad' }

    for (const [what, text] of Object.entries(says)) {
      const observed = declared[what]

      if (observed?.observation === 'member-api') {
        if (typeof observed.refused !== 'boolean' || typeof observed.ruleIdentity !== 'boolean' || observed.childAttempts !== 0) {
          throw new HarnessError(`invalid member API observation: ${what}`)
        }

        assert.equal(observed.refused, true, `${what}: the exported validator accepted the malformed declaration`)
        assert.equal(observed.ruleIdentity, true, `${what}: the refusal was not the isolated RunnerError`)
        assert.ok(observed.refusal.includes(text), `${what}: wrong rule refusal: ${observed.refusal}`)
        continue
      }

      const refused = observed?.stderr.split('\n').find((line) => /^(?:error|Error): (?:the group |member \d+ of the group |variants repeat )/.test(line)) || ''

      if (!observed || observed.timedOut || (!/^HARNESS \[.*\]$/m.test(observed.stdout) && !refused)) {
        throw new HarnessError(`the declaration ${what} crashed or did not return a rule refusal`)
      }

      assert.ok(declared[what] && !declared[what].error && declared[what].timedOut === false, `the run of ${what} did not end`)
      assert.equal(declared[what].code, 2, `${what}: the status of the run`)
      assert.ok(refused.includes(text), `${what}: no "${text}" in ${declared[what].stderr.split('\n').find((line) => line.includes('group')) || declared[what].stderr.split('\n')[0]}`)
      assert.equal(declared[what].started, 0, `${what}: a variant started`)
    }
  }],
  ['width-default', ['widthDefault'], 'a suite that names no width runs as many workers as CHECK_JOBS gives it (2), not the cores of the machine (4): the variants of its pool are dealt round robin to them, in the order of the pool, and the workers run side by side', ({ widthDefault }) => {
    ran(widthDefault, 'the run of a suite that names no width, with CHECK_JOBS=2')
    assert.deepStrictEqual(widthDefault.workers.queues, ['r1,r3,r5', 'r2,r4,r6'])
    assert.equal(widthDefault.workers.peak, 2, 'the two workers ran side by side')
  }],
  ['width-explicit', ['widthExplicit'], 'a suite that names a width (3) runs that many workers side by side whatever CHECK_JOBS says (1): the variants of its pool are dealt round robin to them, in the order of the pool', ({ widthExplicit }) => {
    ran(widthExplicit.wide, 'the run of a suite that names a width of 3, with CHECK_JOBS=1')
    assert.deepStrictEqual(widthExplicit.wide.workers.queues, ['r1,r4', 'r2,r5', 'r3,r6'])
    assert.equal(widthExplicit.wide.workers.peak, 3, 'the three workers ran side by side')
  }],
  ['width-same', ['widthExplicit'], 'the totals and the record of each variant of a run at a named width are those of the run in one worker, each variant recorded once', ({ widthExplicit }) => {
    const timeless = (record) => Object.fromEntries(Object.entries(record).map(([key, result]) => [key, { ...result, seconds: 0 }]))

    ran(widthExplicit.one, 'the run in one worker')
    ran(widthExplicit.wide, 'the run at a width of 3')
    assert.equal(totalsOf(widthExplicit.wide.stdout), totalsOf(widthExplicit.one.stdout))
    assert.deepStrictEqual(timeless(widthExplicit.wide.record), timeless(widthExplicit.one.record))
    assert.equal(widthExplicit.wide.rows, widthExplicit.one.rows, 'a line of the record for each variant, none twice')
  }],
  ['width-cap', ['widthCap'], 'a named width is held to the cores of the machine: 3 workers asked of a machine of 4 threads (2 cores) are 2, the variants of the pool dealt round robin to them', ({ widthCap }) => {
    ran(widthCap, 'the run of a suite that names a width of 3 on 2 cores')
    assert.deepStrictEqual(widthCap.workers.queues, ['r1,r3,r5', 'r2,r4,r6'])
  }],
  ['width-ordered', ['widthOrdered'], '--variants runs its variants in one worker, in the order it gives them, whatever width the suite names (3)', ({ widthOrdered }) => {
    ran(widthOrdered, 'the run of three variants of a suite that names a width of 3')
    assert.deepStrictEqual(widthOrdered.workers.queues, ['r3,r1,r2'])
  }],
  ['width-deaths', ['widthDeaths'], 'a worker that dies at a width of 2 is counted as at one: after three workers in a row end without finishing a variant the rest of its queue fails by name, never started', ({ widthDeaths }) => {
    ran(widthDeaths, 'the dying suite at a width of 2')
    assert.deepStrictEqual(widthDeaths.workers.queues, ['c1,c2,c3,d4,d5', 'c2,c3,d4,d5', 'c3,d4,d5', 'w1,w2,w3,w4'])

    for (const key of ['d4', 'd5']) {
      harnessHas(widthDeaths, key, 'not run: 3 workers in a row ended')
    }
  }],
  ['width-zero', ['widthInvalid'], 'a width of 0 names none: the run is the default\'s, as many workers as CHECK_JOBS gives it', ({ widthInvalid }) => {
    fellBack(widthInvalid['width-zero'], 'the run of a suite that names a width of 0')
  }],
  ['width-text', ['widthInvalid'], 'a width that is no number ("x") names none: the run is the default\'s, as many workers as CHECK_JOBS gives it', ({ widthInvalid }) => {
    fellBack(widthInvalid['width-text'], 'the run of a suite that names a width of "x"')
  }],
  ['width-fraction', ['widthInvalid'], 'a width with a fraction (2.5) names none: the run is the default\'s, as many workers as CHECK_JOBS gives it', ({ widthInvalid }) => {
    fellBack(widthInvalid['width-fraction'], 'the run of a suite that names a width of 2.5')
  }],
  ['width-negative', ['widthInvalid'], 'a width below 0 (-2) names none: the run is the default\'s, as many workers as CHECK_JOBS gives it', ({ widthInvalid }) => {
    fellBack(widthInvalid['width-negative'], 'the run of a suite that names a width of -2')
  }],
]

const EVERY = ['all', 'leaky', 'control', 'late', 'closing', 'interrupted', 'tornClose', 'deaths', 'setup', 'setupClose', 'resume', 'steps', 'repeated', 'prepared', 'racing', 'grouped', 'solo', 'selected', 'groupControl', 'groupHang', 'declared', 'deadlineClock', 'closeArmWitness', 'listWitness', 'childWitness', ...WIDTHS]

/* eslint-disable no-template-curly-in-string */
// [name, from, to, scenarios to run, the check ids one of which must fail, the file rewritten (the runner when not given)]
const MUTANTS = [
  ['an overdue deadline is measured from the old worker phase instead of the parent begin', 'Date.now() - deadline.parentObserved' + ' >= DEADLINE_UPPER_MS', 'Date.now() - deadline.at >= DEADLINE_UPPER_MS', ['deadlineClock'], ['deadline-clock'], SELF],

  ['the default variant order is reversed', ': list\n  const args = ', ': [...list].reverse()\n  const args = ', ['all'], ['order'], RUNNER, 'finite-failures'],
  ['an error thrown by a variant is dropped from the harness result', 'harness = firstLine(error)', 'harness = null', ['all'], ['thrown']],
  ['the control credits a reset that leaves the planted state behind', 'cleared.checks > 0 && cleared.failures === 0', 'cleared.checks > 0', ['leaky'], ['control-leak']],
  ['a lazy preparation uses the setup deadline instead of its variant deadline', 'arm(variant.deadline, `the variant ${variant.key}`)', 'arm(setup, `the variant ${variant.key}`)', ['prepared'], ['prepare-lazy']],
  ['a group deadline is reported as another kind of work', 'arm(variant.deadline, `the variant ${variant.key}`)', 'arm(variant.deadline, `the member ${variant.key}`)', ['groupHang'], ['group-hang']],

  ['a variant past its deadline is never ended', 'arm(variant.deadline, `the variant ${variant.key}`)', 'arm(1e6, `the variant ${variant.key}`)', ['all'], ['deadline']],
  ['a worker is heard after its deadline has passed', 'if (reason) {', 'if (false) {', ['late'], ['late']],
  ['a defect of the harness is counted as passed', 'checks: 1, failures: 1, extra: {}, harness: reason', 'checks: 1, failures: 0, extra: {}, harness: reason', ['all'], ['totals'], RUNNER, 'finite-failures'],
  ['an error a variant throws is not counted', 'if (harness && !own) {', 'if (false) {', ['all'], ['totals'], RUNNER, 'finite-failures'],
  ['a control is credited though its reset failed', 'failures: harness ? own.checks : own.failures', 'failures: own.failures', ['control'], ['control-reset']],
  ['a worker that ends is not charged to its variant', 'failed(ended.current.variant, ended.reason, ended.current.lines, (Date.now() - ended.current.began) / 1000)', 'void ended', ['all'], ['crash']],
  ['nothing bounds the close of a worker', "arm(between, 'the close of the worker')", 'clearTimeout(timer)', ['closing', 'setupClose'], ['closing', 'setup-close'], RUNNER, 'close-arm'],
  ['the close is bounded by the setup deadline', "arm(between, 'the close of the worker')", "arm(setup, 'the close of the worker')", ['closing', 'setupClose'], ['closing', 'setup-close'], RUNNER, 'close-arm'],
  ['the close is not said as it begins', "    say('closing')\n", '', ['closing', 'setupClose'], ['closing', 'setup-close'], RUNNER, 'close-arm'],
  ['a setup that throws is not said', '      say(`unprepared ${firstLine(error)}`)\n', '', ['setup', 'setupClose'], ['setup', 'setup-close']],
  ['the error of a setup that throws is not heard', 'unprepared = body', 'void body', ['setup', 'setupClose'], ['setup', 'setup-close']],
  ['the deadline the close of a failed setup ran past is dropped', "${ended.expired ? `; ${ended.reason}` : ''}", '', ['setupClose'], ['setup-close']],
  ['a defect of a worker is not kept in the record', 'fs.appendFileSync(file, `${JSON.stringify({ problem: text })}\\n`)', 'void text', ['closing'], ['closing-resume']],
  ['the control skips the reset between the fault and the head', '    await afterEach(target)\n', '', ['all'], ['control']],
  ['the breaker never stops a queue whose workers keep dying', 'if (rest.length && deaths >= DEATHS) {', 'if (false) {', ['deaths'], ['deaths']],
  ['a worker that finished a variant counts toward the breaker', 'deaths = ended.done.length ? 0 : deaths + 1', 'deaths = ended.done.length ? 1 : deaths + 1', ['deaths'], ['deaths']],
  ['the record is not written as each variant ends', 'fs.appendFileSync(file, `${JSON.stringify(defect ? { ...result, problem: defect } : result)}\\n`)', 'void file', ['resume'], ['resume-skips']],
  ['a resumed run runs again what was done', 'const results = new Map(resumed ? [...resumed.done].filter(([key]) => byKey.has(key)) : [])', 'const results = new Map()', ['resume', 'grouped'], ['resume-skips', 'resume-again', 'group-resume']],
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
  ['the steps of an observation do not reach the runner', 'step: (phase) => { record.phase = phase; at(record, phase) }', 'step: (phase) => { record.phase = phase }', ['steps'], ['step-observed'], OBSERVER],
  ['an observation that ends hides the step of one still open beside it', 'open.delete(record)', 'open.clear()', ['steps'], ['step-parallel'], OBSERVER],
  ['a key given again keeps its own key', 'return run === 1 ? key : `${key}#${run}`', 'return key', ['repeated'], ['repeat']],
  ['a worker does not know the run of a key given again', 'parsed.worker.map((key) => runOf(byKey, key))', 'parsed.worker.map((key) => byKey.get(key))', ['repeated'], ['repeat']],
  ['the setup is handed the run of a key given again', 'await prepare(queue.map(defined))', 'await prepare(queue)', ['repeated'], ['repeat']],
  ['the reset is handed the run of a key given again', 'await afterEach(defined(variant))', 'await afterEach(variant)', ['repeated'], ['repeat']],
  ['the wait of the setup is charged to the deadline of the first variant', '    try {\n      await prepare(queue.map(defined))', '    say(`begin ${queue[0].key}`)\n    try {\n      await prepare(queue.map(defined))', ['prepared'], ['prepare-first', 'prepare-resumed']],
  ['a child past its limit is never ended', 'const timer = limit ? setTimeout(', 'const timer = false ? setTimeout(', ['prepared'], ['child-limit'], POOL, 'child-api'],
  ['a child ended at its limit is not said to be', '    timedOut = true\n', '', ['prepared'], ['child-limit'], POOL, 'child-api'],
  ['a child that ends as it is ended at its limit keeps its own status', 'code: timedOut ? null : code', 'code', ['racing'], ['child-race'], POOL],
  ['a group runs a part of its members', 'run: () => variant.run(members) }]', 'run: () => variant.run([members[0]]) }]', ['grouped'], ['group-run']],
  ['a group is run under the name of the group alone', "name: `${variant.name}: ${members.map((member) => member.name).join('; ')}`", 'name: variant.name', ['selected'], ['group-only']],
  ['--solo does not split the groups', 'listOf(variants, control, deadline, parsed.solo)', 'listOf(variants, control, deadline, false)', ['solo'], ['solo-run']],
  ['--solo does not reach the workers', 'workerArgs: [...parsed.rest, ...(parsed.solo ? [\'--solo\'] : [])]', 'workerArgs: parsed.rest', ['solo'], ['solo-run']],
  ['--solo is no part of the arguments of the record', "...(parsed.variants ? [`--variants=${parsed.variants.join(',')}`] : []), ...(parsed.solo ? ['--solo'] : [])]", "...(parsed.variants ? [`--variants=${parsed.variants.join(',')}`] : [])]", ['solo'], ['solo-resume']],
  ['a member run alone is handed the whole group', 'run: () => variant.run([member]) }))', 'run: () => variant.run(members) }))', ['solo'], ['solo-run', 'solo-one']],
  ['the members run alone share one name', 'name: `${variant.name}, alone: ${member.name}`', 'name: variant.name', ['solo'], ['solo-run'], RUNNER, 'solo-names'],
  ['the control names a group that --solo split and finds none', 'byKey.get(control.fault) || byKey.get(first.get(control.fault))', 'byKey.get(control.fault)', ['groupControl'], ['group-control'], RUNNER, 'solo-control'],
  ['a group of one member is declared', 'members.length < (alone ? 1 : 2)', 'false', ['declared'], ['group-declared'], RUNNER, 'declared-member-api'],
  ['groups of one key are accepted before they are expanded', 'variants.map(({ key }) => key).filter((key, at, all) => all.indexOf(key) !== at)', '[]', ['declared'], ['group-declared'], RUNNER, 'declared-member-api'],
  ['a member without a key, or with a key that cannot be told apart, is declared', "typeof member.key !== 'string' || !MEMBER_KEY.test(member.key)", "typeof member.key !== 'string'", ['declared'], ['group-declared'], RUNNER, 'declared-member-api'],
  ['a member without a name is declared', "typeof member.name !== 'string' || !member.name", 'false', ['declared'], ['group-declared'], RUNNER, 'declared-member-api'],
  ['a missing member check list is silently replaced by an empty one', '!Array.isArray(member.fails) || member.fails.some(', '!Array.isArray(member.fails = member.fails || []) || member.fails.some(', ['declared'], ['group-declared'], RUNNER, 'declared-member-api'],
  ['two members with one key are declared', 'other.key === member.key || other.name === member.name', 'other.name === member.name', ['declared'], ['group-declared'], RUNNER, 'declared-member-api'],
  ['two members with one name are declared', 'other.key === member.key || other.name === member.name', 'other.key === member.key', ['declared'], ['group-declared'], RUNNER, 'declared-member-api'],
  ['faults and rewrites in one group are declared', 'if (members.some(({ fails }) => !fails.length) && members.some(({ fails }) => fails.length)) {', 'if (false) {', ['declared'], ['group-declared'], RUNNER, 'declared-member-api'],
  ['two members that name one check are declared', 'if (owners.has(id) && owners.get(id) !== member) {', 'if (false) {', ['declared'], ['group-declared'], RUNNER, 'declared-member-api'],
  ['a close timer registered by another dispatch is accepted', 'timer.delay === expected.betweenMS && timer.' + "dispatch === 'closing'", 'timer.delay === expected.betweenMS', ['closeArmWitness'], ['close-arm-witness'], SELF],
  ['duplicate solo names are accepted by the value witness', 'correct: unique && names.' + 'every((name, at) => name === expected[at])', 'correct: true', ['listWitness'], ['list-witness'], SELF],
  ['the child API witness accepts an unbounded child as bounded', 'correct: seen.registered.length === 1 && ' + "seen.registered[0] === 8000 && seen.killedByTimer && seen.result.timedOut && seen.result.code === null && seen.result.stderr.endsWith('the child did not finish in 8 s\\n')", 'correct: true', ['childWitness'], ['child-api-witness'], SELF],

  ['a width the suite names is ignored', 'Number.isInteger(named) && named > 0 ? Math.min(named, cores()) : jobs()', 'jobs()', ['widthExplicit'], ['width-explicit']],
  ['the workers run as many at once as CHECK_JOBS says though the suite names a width', 'const limit = ordered ? 1 : widthOf(width)', 'const limit = ordered ? 1 : jobs()', ['widthExplicit'], ['width-explicit']],
  ['the queues are not dealt for the width the suite names', 'queuesOf(selected, ordered, width).filter(', 'queuesOf(selected, ordered).filter(', ['widthExplicit'], ['width-explicit']],
  ['the width the suite names is not handed to the supervisor', 'between, width: workers, workerArgs', 'between, workerArgs', ['widthExplicit'], ['width-explicit']],
  ['the variants of a pool are dealt to queues that overlap', 'place % count === at', 'place % count <= at', ['widthExplicit'], ['width-same']],
  ['a named width is not held to the cores', 'Math.min(named, cores())', 'named', ['widthCap'], ['width-cap']],
  ['a width that is not named falls back to the cores instead of CHECK_JOBS', 'Math.min(named, cores()) : jobs()', 'Math.min(named, cores()) : cores()', ['widthDefault'], ['width-default']],
  ['the variants of a pool are dealt in blocks, not round robin', 'place % count === at', 'Math.floor(place * count / list.length) === at', ['widthDefault'], ['width-default']],
  ['the workers run one at a time whatever the width', 'const limit = ordered ? 1 : widthOf(width)', 'const limit = 1', ['widthDefault'], ['width-default']],
  ['--variants is dealt to the workers like a pool', 'if (ordered) {', 'if (false) {', ['widthOrdered'], ['width-ordered']],
  ['the breaker never stops a queue whose workers keep dying, at a width of 2', 'if (rest.length && deaths >= DEATHS) {', 'if (false) {', ['widthDeaths'], ['width-deaths']],
  ['the breaker stops a queue after two workers in a row that ended without finishing a variant, at a width of 2', 'if (rest.length && deaths >= DEATHS) {', 'if (rest.length && deaths >= 2) {', ['widthDeaths'], ['width-deaths']],
  ['a width of 0 falls back to the cores instead of CHECK_JOBS', 'Math.min(named, cores()) : jobs()', 'Math.min(named, cores()) : named === 0 ? cores() : jobs()', ['widthInvalid'], ['width-zero']],
  ['a width that is no number falls back to the cores instead of CHECK_JOBS', 'Math.min(named, cores()) : jobs()', 'Math.min(named, cores()) : Number.isNaN(named) ? cores() : jobs()', ['widthInvalid'], ['width-text']],
  ['a width with a fraction falls back to the cores instead of CHECK_JOBS', 'Math.min(named, cores()) : jobs()', 'Math.min(named, cores()) : named > 0 && !Number.isInteger(named) ? cores() : jobs()', ['widthInvalid'], ['width-fraction']],
  ['a width below 0 falls back to the cores instead of CHECK_JOBS', 'Math.min(named, cores()) : jobs()', 'Math.min(named, cores()) : named < 0 ? cores() : jobs()', ['widthInvalid'], ['width-negative']],
  ['the totals count the variants of the first queue only', 'for (const variant of selected) {\n    const result', 'for (const variant of queues[0]) {\n    const result', ['widthExplicit'], ['width-same']],
  ['the record keeps the variants of the first queue only', 'fs.appendFileSync(file, `${JSON.stringify(defect ? { ...result, problem: defect } : result)}\\n`)', 'queues[0].some(({ key }) => key === result.key) && fs.appendFileSync(file, `${JSON.stringify(defect ? { ...result, problem: defect } : result)}\\n`)', ['widthExplicit'], ['width-same']],
  ['the rest of a queue whose workers keep dying is not said to be not run', 'not run: ${DEATHS} workers in a row ended without finishing a variant', 'the worker did not finish', ['widthDeaths'], ['width-deaths']],
]

// Rewrites of the runner that change nothing a run does: each must leave every check of the scenarios it touches passing. [name, from, to, scenarios to run]
const BENIGN = [
  ['the trees compared the other way round', 'if (kept.tree !== header.tree) {', 'if (header.tree !== kept.tree) {', ['resume']],
  ['the deadline given as a number', 'arm(variant.deadline, `the variant ${variant.key}`)', 'arm(Number(variant.deadline), `the variant ${variant.key}`)', ['all', 'late']],
  ['a step kept to a longer cut', '.slice(0, 300)', '.slice(0, 400)', ['steps']],
  ['the cap on a named width taken the other way round', 'Math.min(named, cores())', 'Math.min(cores(), named)', ['widthCap']],
]
/* eslint-enable no-template-curly-in-string */

const judge = (seen, needs, checks = null) => CHECKS.filter(([id, wanted]) => (checks === null || checks.includes(id)) && wanted.every((need) => needs.includes(need))).map(([id, , name, run]) => {
  try {
    run(seen)

    return { id, name, ok: true, detail: '' }
  } catch (error) {
    if (kindOf(error) !== 'assertion') {
      throw error instanceof HarnessError ? error : new HarnessError(`the check ${id} could not observe its value: ${error.message}`)
    }

    return { id, name, ok: false, detail: String(error.message).split('\n')[0].slice(0, 600) }
  }
})

const main = async () => {
  const mutations = mutating()
  const only = (process.argv.find((argument) => argument.startsWith('--only=')) || '').slice('--only='.length)
  const every = only ? only.split(',') : EVERY

  if (every.some((need) => !EVERY.includes(need))) {
    throw new HarnessError(`unknown suite-runner context: ${only}`)
  }

  const mutants = MUTANTS.filter(([, , , needs]) => needs.every((need) => every.includes(need)))
  const rewrites = BENIGN.filter(([, , , needs]) => needs.every((need) => every.includes(need)))
  let checks = 0
  let failures = 0
  const check = (name, ok, detail = '') => {
    checks++

    if (!ok) {
      failures++
    }

    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` (${detail})`}`)
  }
  const sources = { [SELF]: fs.readFileSync(path.join(__dirname, 'check-suite-runner.js'), 'utf8'), [RUNNER]: fs.readFileSync(path.join(LIB, 'suite-runner.js'), 'utf8'), [OBSERVER]: fs.readFileSync(path.join(LIB, 'browser-observe.js'), 'utf8'), [POOL]: fs.readFileSync(path.join(LIB, 'check-pool.js'), 'utf8') }

  for (const result of judge(await observe(sources, every), every)) {
    check(result.name, result.ok, result.detail)
  }

  if (mutations) {
    console.log('\nPlanted faults')

    for (const [name, from, to, needs, caught, file = RUNNER, profile = null] of mutants) {
      const checks = caught
      const contexts = observationContexts(profile, file, from, sources[file], needs, caught)
      const failed = judge(await observe({ ...sources, [file]: plantedPatch(file, sources[file], from, to) }, needs, checks, contexts), needs, checks).filter((result) => !result.ok).map((result) => result.id)

      check(`planted: ${name}: caught by ${failed.join(', ') || 'nothing'}`, caught.some((id) => failed.includes(id)), `expected one of ${caught.join(', ')}`)
    }

    console.log('\nBenign rewrites')

    for (const [name, from, to, needs] of rewrites) {
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
