/*
  Checks scripts/run-check.js, the way a full run is started so that it outlives the starter's turn, in a layout of its own (a copy of run-check and check-pool, and a check script that passes after TINY_MS), through these scenarios:
  - `normal`: a run started and waited for ends `done`, with the status and the summary line of its script, its supervisor the one `start` named, and `wait` ends with that status;
  - `stale`: the starter runs with each of its reads of the status held, once read, until the state on disk has moved on from the state it read (scripts/stale-starter.js of the layout), as a loaded machine can hold a process between a read and what it does with it, so that the supervisor ends while the starter holds a status it read before: the run still reads `done`, with its script's status, and `wait` ends with it, never as a run whose supervisor is gone;
  - `expired`: with a startup time of 3 s, the starter holds its initial status read for 4 s after observing a live supervisor and child on disk; the acknowledged run must still complete rather than be killed by a startup decision made from the held snapshot;
  - `early`: a supervisor planted to end before its first write leaves the run `failed`, with why, and `start` and `wait` end with status 2, `wait` at once;
  - `hung`: a supervisor planted to wait 20 s before its first write, with a startup time of 3 s, is ended, and the run is `failed`, with why;
  - `pending`: a run whose starter wrote the status and whose supervisor has not (planted) is starting: `start` refuses a second run of its name, `status` does not call it lost and `wait` waits for it; one planted two minutes ago is lost, and `wait` ends at once with status 2.
  - `claimed`: a cancelled startup prevents a late supervisor from writing status or starting a check; `publishing` stalls before the first status write, and `cancelled` delays commitment after writing the pid so timeout wins before the supervisor can start work.
  Each planted fault rewrites a line of the copy of run-check and must make a named check fail; each benign rewrite must make none of the checks of the scenarios it touches fail.

  --only=<scenario>,<scenario> runs those scenarios and only the planted faults and rewrites whose scenarios all appear in that list.
  Prints `N of N checks passed`; any failed check sets exit code 1.
*/
const fs = require('fs')
const os = require('os')
const path = require('path')
const assert = require('./lib/bounded-assert')
const { inParallel, killTree, runChild } = require('./lib/check-pool')
const { patched } = require('./lib/mutant-source')

const RUN_CHECK = 'scripts/run-check.js'
const LIMIT = 30000
// The check script of the layout: it passes after TINY_MS.
const TINY = "setTimeout(() => console.log('1 of 1 checks passed'), Number(process.env.TINY_MS) || 0)\n"
// The starter of `stale`: run-check with each read of the status held, once read, until the state on disk has moved on from the state it read (20 s at most).
const STALE_STARTER = [
  "const fs = require('fs')",
  'const read = fs.readFileSync',
  'const held = new Int32Array(new SharedArrayBuffer(4))',
  'fs.readFileSync = (file, ...rest) => {',
  '  const text = read(file, ...rest)',
  "  if (String(file).endsWith('status.json')) {",
  '    const until = Date.now() + 20000',
  "    while (Date.now() < until && JSON.parse(read(file, 'utf8')).state === JSON.parse(text).state) {",
  '      Atomics.wait(held, 0, 0, 50)',
  '    }',
  '  }',
  '  return text',
  '}',
  "require('./run-check.js')",
  '',
].join('\n')
// Holds the initial pre-publication snapshot across startup expiry, but only after the supervisor has published its child, so a timeout decision on that snapshot would kill legitimate work.
const EXPIRED_STARTER = [
  "const fs = require('fs')",
  'const read = fs.readFileSync',
  'const held = new Int32Array(new SharedArrayBuffer(4))',
  'let first = true',
  'fs.readFileSync = (file, ...rest) => {',
  '  const text = read(file, ...rest)',
  "  if (first && String(file).endsWith('status.json') && !JSON.parse(text).supervisor) {",
  '    first = false',
  '    const until = Date.now() + 10000',
  "    while (Date.now() < until && !JSON.parse(read(file, 'utf8')).child) {",
  '      Atomics.wait(held, 0, 0, 25)',
  '    }',
  "    const live = JSON.parse(read(file, 'utf8'))",
  "    console.log('held after publication: ' + Boolean(live.supervisor && live.child))",
  '    Atomics.wait(held, 0, 0, 4000)',
  '  }',
  '  return text',
  '}',
  "require('./run-check.js')",
  '',
].join('\n')
// The rewrites of run-check that plant a supervisor's fault in the layout of a scenario.
const SUPERVISE = 'const supervise = async (name, script, args) => {\n'
const PLANTS = {
  early: [[SUPERVISE, `${SUPERVISE}  throw new Error('a supervisor planted to end before its first write')\n`]],
  hung: [['const STARTUP_SECONDS = 60', 'const STARTUP_SECONDS = 3'], [SUPERVISE, `${SUPERVISE}  await new Promise((resolve) => setTimeout(resolve, 20000))\n`]],
  expired: [['const STARTUP_SECONDS = 60', 'const STARTUP_SECONDS = 3']],
  publishing: [['const STARTUP_SECONDS = 60', 'const STARTUP_SECONDS = 3'], ['  writeStatus(name, status)\n', '  await pause(20000)\n  writeStatus(name, status)\n']],
  cancelled: [['const STARTUP_SECONDS = 60', 'const STARTUP_SECONDS = 3'], ['  writeStatus(name, status)\n', '  writeStatus(name, status)\n  await pause(4500)\n'], ['        killTree(supervisor.pid)\n', '        void supervisor.pid\n']],
}

// A layout of its own: run-check as given in `source`, with the plants of the scenario `need`, check-pool, the check script and the starter of `stale`.
const layoutOf = (source, need) => {
  const layout = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-run-check-'))
  const scripts = path.join(layout, 'scripts')

  fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true })
  fs.writeFileSync(path.join(scripts, 'run-check.js'), (PLANTS[need] || []).reduce((text, [from, to]) => patched(RUN_CHECK, text, from, to), source))
  fs.copyFileSync(path.join(__dirname, 'lib', 'check-pool.js'), path.join(scripts, 'lib', 'check-pool.js'))
  fs.writeFileSync(path.join(scripts, 'check-tiny.js'), TINY)
  fs.writeFileSync(path.join(scripts, 'stale-starter.js'), STALE_STARTER)
  fs.writeFileSync(path.join(scripts, 'expired-starter.js'), EXPIRED_STARTER)

  return layout
}

// One command of run-check in `layout`, through `entry` (run-check itself when not given): { code, stdout, stderr, timedOut }.
const command = (layout, args, { env = {}, limit = LIMIT, entry = 'run-check.js' } = {}) => runChild(path.join(layout, 'scripts', entry), args, { env, limit }).catch((error) => ({ code: null, stdout: '', stderr: String(error.message), timedOut: false }))
const statusFileOf = (layout, name) => path.join(layout, '.check-runs', name, 'status.json')
const statusOf = (layout, name) => (fs.existsSync(statusFileOf(layout, name)) ? JSON.parse(fs.readFileSync(statusFileOf(layout, name), 'utf8')) : null)
// The status of a run whose starter wrote it `age` ms ago and whose supervisor has not written it.
const plant = (layout, name, age) => {
  fs.mkdirSync(path.dirname(statusFileOf(layout, name)), { recursive: true })
  fs.writeFileSync(statusFileOf(layout, name), JSON.stringify({ state: 'starting', script: 'scripts/check-tiny.js', args: [], started: new Date(Date.now() - age).toISOString(), supervisor: null }))
}
const pidOf = (started) => Number((/^started \S+ \(supervisor (\d+)\)/m.exec(started.stdout) || [])[1]) || null
const alive = (pid) => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const SCENARIOS = {
  normal: async (layout) => {
    const started = await command(layout, ['start', '--label=n', 'tiny'])
    const waited = await command(layout, ['wait', 'n'])
    const restarted = await command(layout, ['start', '--label=n', 'tiny'])
    const rewaited = await command(layout, ['wait', 'n'])

    return { started, waited, restarted, rewaited, status: statusOf(layout, 'n') }
  },
  stale: async (layout) => {
    const started = await command(layout, ['start', '--label=s', 'tiny'], { entry: 'stale-starter.js', env: { TINY_MS: '3000' } })
    const waited = await command(layout, ['wait', 's'])

    return { started, waited, status: statusOf(layout, 's') }
  },
  expired: async (layout) => {
    const started = await command(layout, ['start', '--label=x', 'tiny'], { entry: 'expired-starter.js', env: { TINY_MS: '8000' } })
    const waited = await command(layout, ['wait', 'x'])

    return { started, waited, status: statusOf(layout, 'x'), log: fs.readFileSync(path.join(layout, '.check-runs', 'x', 'log.txt'), 'utf8') }
  },
  claimed: async (layout) => {
    plant(layout, 'c', 0)

    const supervised = await command(layout, ['supervise', 'c', path.join(layout, 'scripts', 'check-tiny.js')])

    return { supervised, status: statusOf(layout, 'c'), logged: fs.existsSync(path.join(layout, '.check-runs', 'c', 'log.txt')) }
  },
  early: async (layout) => {
    const started = await command(layout, ['start', '--label=e', 'tiny'])
    const waited = await command(layout, ['wait', 'e'], { limit: 15000 })

    return { started, waited, status: statusOf(layout, 'e') }
  },
  hung: async (layout) => {
    const started = await command(layout, ['start', '--label=h', 'tiny'])
    const status = statusOf(layout, 'h')

    return { started, status, alive: Boolean(status && status.supervisor && alive(status.supervisor)) }
  },
  publishing: async (layout) => {
    const started = await command(layout, ['start', '--label=p', 'tiny'], { limit: 8000 })
    const status = statusOf(layout, 'p')

    return { started, status, alive: Boolean(status && status.supervisor && alive(status.supervisor)), logged: fs.existsSync(path.join(layout, '.check-runs', 'p', 'log.txt')) }
  },
  cancelled: async (layout) => {
    const started = await command(layout, ['start', '--label=c', 'tiny'], { limit: 15000 })
    const waited = await command(layout, ['wait', 'c'], { limit: 8000 })

    return { started, waited, status: statusOf(layout, 'c'), logged: fs.existsSync(path.join(layout, '.check-runs', 'c', 'log.txt')) }
  },
  pending: async (layout) => {
    plant(layout, 'fresh', 0)
    plant(layout, 'old', 120000)

    const refused = await command(layout, ['start', '--label=fresh', 'tiny'])
    const described = await command(layout, ['status', 'fresh', 'old'])
    const waitedFresh = await command(layout, ['wait', 'fresh'], { limit: 5000 })
    const waitedOld = await command(layout, ['wait', 'old'], { limit: 15000 })

    return { refused, described, waitedFresh, waitedOld }
  },
}

// Ends any supervisor a scenario left going (a planted fault can leave one), then removes the layout.
const settle = (layout) => {
  const runs = path.join(layout, '.check-runs')

  for (const name of fs.existsSync(runs) ? fs.readdirSync(runs) : []) {
    const status = statusOf(layout, name)

    if (status && status.supervisor && alive(status.supervisor)) {
      killTree(status.supervisor)
    }
  }

  fs.rmSync(layout, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

const inLayout = async (source, need) => {
  const layout = layoutOf(source, need)

  try {
    return await SCENARIOS[need](layout)
  } catch (error) {
    return { error: String(error.message).split('\n')[0] }
  } finally {
    settle(layout)
  }
}

const observe = async (source, needs) => {
  const seen = {}

  for (const need of needs) {
    seen[need] = await inLayout(source, need)
  }

  return seen
}

const lastLine = (text) => text.trim().split('\n').pop()
// The scenario ran to its end, without an error of its own.
const whole = (seen) => assert.ok(seen && !seen.error, seen && seen.error)
const ran = (run, what) => assert.equal(run.timedOut, false, `${what} did not end in its limit: ${lastLine(run.stderr)}`)

// [id, scenarios it needs, what it holds, the assertions over what they saw]
const CHECKS = [
  ['normal', ['normal'], 'a run started and waited for ends done, with the status and the summary line of its script, its supervisor the one `start` named, and `wait` ends with that status', ({ normal }) => {
    whole(normal)
    ran(normal.started, 'start')
    ran(normal.waited, 'wait')
    ran(normal.restarted, 'restart')
    ran(normal.rewaited, 'the wait after restart')
    assert.equal(normal.restarted.code, 0, lastLine(normal.restarted.stderr))
    assert.equal(normal.rewaited.code, 0, lastLine(normal.rewaited.stdout))
    assert.equal(normal.started.code, 0, lastLine(normal.started.stderr))
    assert.equal(normal.status.state, 'done')
    assert.equal(normal.status.code, 0)
    assert.equal(normal.status.summary, '1 of 1 checks passed')
    assert.equal(normal.status.supervisor, pidOf(normal.restarted))
    assert.equal(normal.waited.code, 0, lastLine(normal.waited.stdout))
  }],
  ['stale', ['stale'], 'a starter held after each read of the status, until the run has moved on from what it read, writes nothing over the supervisor: the run that ended reads done, with its script\'s status, and `wait` ends with it, never as a run whose supervisor is gone', ({ stale }) => {
    whole(stale)
    ran(stale.started, 'the held start')
    ran(stale.waited, 'wait')
    assert.equal(stale.started.code, 0, lastLine(stale.started.stderr))
    assert.equal(stale.status.state, 'done', `the run reads ${stale.status.state}`)
    assert.equal(stale.status.code, 0)
    assert.equal(stale.waited.code, 0, lastLine(stale.waited.stdout))
  }],
  ['expired', ['expired'], 'a pre-publication read held across the startup deadline cannot authorize killing a supervisor that has already published and started work', ({ expired }) => {
    whole(expired)
    ran(expired.started, 'the held start')
    ran(expired.waited, 'wait')
    assert.ok(expired.started.stdout.includes('held after publication: true'), expired.started.stdout)
    assert.equal(expired.started.code, 0, lastLine(expired.started.stderr))
    assert.equal(expired.status.state, 'done', `the run reads ${expired.status.state}`)
    assert.equal(expired.status.code, 0)
    assert.equal(expired.waited.code, 0, lastLine(expired.waited.stdout))
    assert.ok(expired.log.includes('1 of 1 checks passed'), expired.log)
  }],
  ['early', ['early'], 'a supervisor that ends before its first write leaves the run failed, with why, and `start` and `wait` end with status 2, `wait` at once', ({ early }) => {
    whole(early)
    ran(early.started, 'start')
    ran(early.waited, 'wait')
    assert.equal(early.started.code, 2)
    assert.ok(early.started.stderr.includes('e did not start: the supervisor ended with status 2 before it published startup'), lastLine(early.started.stderr))
    assert.equal(early.status.state, 'failed')
    assert.equal(early.status.summary, 'the supervisor ended with status 2 before it published startup')
    assert.equal(early.waited.code, 2)
    assert.ok(/^e: failed/m.test(early.waited.stdout), early.waited.stdout)
  }],
  ['hung', ['hung'], 'a supervisor that does not make its first write in the startup time is ended, and the run is failed, with why', ({ hung }) => {
    whole(hung)
    ran(hung.started, 'start')
    assert.equal(hung.started.code, 2)
    assert.equal(hung.status.state, 'failed')
    assert.equal(hung.status.summary, 'the supervisor did not publish startup in 3 s and was ended')
    assert.equal(hung.alive, false, 'the supervisor is still alive')
    assert.ok(hung.status.seconds < 15, `startup termination took ${hung.status.seconds} s instead of ending the supervisor at 3 s`)
  }],
  ['pending', ['pending'], 'a run whose supervisor has not written yet is starting: `start` refuses a second run of its name, `status` does not call it lost and `wait` waits for it; one that has been starting past the startup time is lost, and `wait` ends at once with status 2', ({ pending }) => {
    whole(pending)
    ran(pending.refused, 'the second start')
    assert.equal(pending.refused.code, 2)
    assert.ok(pending.refused.stderr.includes('a run of fresh is starting; wait for it or end it first'), lastLine(pending.refused.stderr))
    assert.ok(/^fresh: starting after/m.test(pending.described.stdout), pending.described.stdout)
    assert.ok(/^old: lost/m.test(pending.described.stdout), pending.described.stdout)
    assert.equal(pending.waitedFresh.timedOut, true, 'wait ended while the run was starting')
    ran(pending.waitedOld, 'the wait for the run that has been starting too long')
    assert.equal(pending.waitedOld.code, 2)
    assert.ok(/^old: lost/m.test(pending.waitedOld.stdout), pending.waitedOld.stdout)
  }],
  ['claimed', ['claimed'], 'a supervisor that loses the startup claim exits before writing status or starting the check', ({ claimed }) => {
    whole(claimed)
    ran(claimed.supervised, 'the losing supervisor')
    assert.equal(claimed.supervised.code, 2)
    assert.equal(claimed.status.state, 'starting')
    assert.equal(claimed.status.supervisor, null)
    assert.equal(claimed.logged, false, 'the losing supervisor started its log or check')
  }],
  ['publishing', ['publishing'], 'a supervisor stalled before its first status write remains bounded and starts no check', ({ publishing }) => {
    whole(publishing)
    ran(publishing.started, 'the stalled publication')
    assert.equal(publishing.started.code, 2)
    assert.equal(publishing.status.state, 'failed')
    assert.equal(publishing.status.summary, 'the supervisor did not publish startup in 3 s and was ended')
    assert.equal(publishing.alive, false)
    assert.equal(publishing.logged, false)
  }],
  ['cancelled', ['cancelled'], 'timeout winning after the supervisor writes its pid prevents work and cannot be acknowledged as a successful start', ({ cancelled }) => {
    whole(cancelled)
    ran(cancelled.started, 'the cancelled start')
    ran(cancelled.waited, 'the cancelled wait')
    assert.equal(cancelled.started.code, 2)
    assert.equal(cancelled.waited.code, 2)
    assert.equal(cancelled.status.state, 'failed')
    assert.equal(cancelled.status.summary, 'the supervisor did not publish startup in 3 s and was ended')
    assert.equal(cancelled.logged, false, 'a cancelled supervisor started work')
  }],
]

// [name, from, to, scenarios to run, the check ids one of which must fail]
const MUTANTS = [
  ['the starter writes the status it read over the supervisor\'s, after the supervisor\'s first write', '  supervisor.unref()\n', '  writeStatus(name, { ...seen, supervisor: supervisor.pid })\n  supervisor.unref()\n', ['normal', 'stale'], ['stale']],
  ['the starter takes the run as failed though the supervisor committed', 'if (!published()) {', 'if (true) {', ['normal'], ['normal']],
  ['an uncommitted supervisor leaves the run starting', 'if (!published()) {', 'if (false) {', ['early'], ['early']],
  ['the starter waits for publication from a supervisor that has ended', 'while (!published() && !ended) {', 'while (!published()) {', ['early'], ['early']],
  ['a supervisor that does not make its first write is never ended', '        killTree(supervisor.pid)\n', '', ['hung'], ['hung']],
  ['start launches a second run of a name that is starting', 'if (going(before) || starting(before)) {', 'if (going(before)) {', ['pending'], ['pending']],
  ['wait gives up on a run that is starting', 'while (going(readStatus(name)) || starting(readStatus(name))) {', 'while (going(readStatus(name))) {', ['pending'], ['pending']],
  ['a run is starting for ever', ' && Date.now() - Date.parse(status.started) < STARTUP_SECONDS * 1000', '', ['pending'], ['pending']],
  ['a run that is starting is called lost', ' && !alive(status.supervisor) && !starting(status)', ' && !alive(status.supervisor)', ['pending'], ['pending']],
  ['startup expiry kills without winning publication ownership', 'if (takeStartup(name)) {', 'if (true) {', ['expired'], ['expired']],
  ['a supervisor writes after startup was cancelled', 'if (!fs.existsSync(startupFile(name))) {', 'if (false) {', ['claimed'], ['claimed']],
  ['a launch creates no publication token', "  fs.writeFileSync(startupFile(name), '')\n", '', ['normal'], ['normal']],
  ['supervisor work starts after losing commitment to timeout', 'if (!takeStartup(name)) {', 'if (false) {', ['cancelled'], ['cancelled']],
  ['a written pid bypasses startup arbitration', '!late && seen.supervisor === supervisor.pid && !fs.existsSync(startupFile(name))', 'seen.supervisor === supervisor.pid', ['cancelled'], ['cancelled']],
  ['a token is consumed before the first status write', '  writeStatus(name, status)\n\n  if (!takeStartup(name)) {\n    throw new Error(\'startup was cancelled before supervisor commitment\')\n  }', '  if (!takeStartup(name)) {\n    throw new Error(\'startup was cancelled before supervisor commitment\')\n  }\n\n  writeStatus(name, status)', ['publishing'], ['publishing']],
]

// Rewrites of run-check that change nothing a run does: each must leave every check of the scenarios it touches passing. [name, from, to, scenarios to run]
const BENIGN = [
  ['the end of the supervisor taken after the read, in the same step', '    ended = exited\n    seen = readStatus(name)', '    seen = readStatus(name)\n    ended = exited', ['normal', 'stale', 'early']],
  ['a poll every 150 ms', 'const POLL_MS = 100', 'const POLL_MS = 150', ['normal', 'stale']],
  ['publication races with a 200 ms poll', 'const POLL_MS = 100', 'const POLL_MS = 200', ['expired', 'claimed', 'hung', 'publishing', 'cancelled']],
]

const judge = (seen, needs) => CHECKS.filter(([, wanted]) => wanted.every((need) => needs.includes(need))).map(([id, , name, run]) => {
  try {
    run(seen)

    return { id, name, ok: true, detail: '' }
  } catch (error) {
    return { id, name, ok: false, detail: String(error.message).split('\n')[0].slice(0, 600) }
  }
})

// The ids of the checks that fail over `source` rewritten from `from` to `to`, for each rewrite, several at a time.
const failingOf = (source, rewrites) => inParallel(rewrites, async ([, from, to, needs]) => judge(await observe(patched(RUN_CHECK, source, from, to), needs), needs).filter((result) => !result.ok))

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
  const source = fs.readFileSync(path.join(__dirname, 'run-check.js'), 'utf8')
  const only = (process.argv.find((argument) => argument.startsWith('--only=')) || '').slice('--only='.length)
  const every = only ? only.split(',') : Object.keys(SCENARIOS)

  for (const need of every) {
    if (!Object.hasOwn(SCENARIOS, need)) {
      throw new Error(`unknown scenario ${need}`)
    }
  }

  const mutants = MUTANTS.filter(([, , , needs]) => needs.every((need) => every.includes(need)))
  const rewrites = BENIGN.filter(([, , , needs]) => needs.every((need) => every.includes(need)))

  for (const result of judge(await observe(source, every), every)) {
    check(result.name, result.ok, result.detail)
  }

  if (mutations) {
    console.log('\nPlanted faults')

    const planted = await failingOf(source, mutants)

    mutants.forEach(([name, , , , caught], at) => {
      const failed = planted[at] instanceof Error ? [] : planted[at].map((result) => result.id)

      check(`planted: ${name}: caught by ${failed.join(', ') || 'nothing'}`, caught.some((id) => failed.includes(id)), planted[at] instanceof Error ? planted[at].message : `expected one of ${caught.join(', ')}`)
    })

    console.log('\nBenign rewrites')

    const benign = await failingOf(source, rewrites)

    rewrites.forEach(([name], at) => {
      const failed = benign[at] instanceof Error ? [{ id: 'the rewrite', detail: benign[at].message }] : benign[at]

      check(`benign: ${name}: no check fails`, failed.length === 0, failed.map((result) => `${result.id}: ${result.detail}`).join('; '))
    })
  }

  console.log(`\n${checks - failures} of ${checks} checks passed`)
  process.exitCode = failures ? 1 : 0
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
