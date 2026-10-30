/*
  Runs a check suite: its heads (the checks of the sources as they are) and its variants (planted faults, equivalent rewrites, controls) in worker processes, one after another in each, with a deadline for each variant and a record of each variant once it is done, from which a run that was stopped is resumed.

  const { runSuite, runnerArgs, step } = require('./lib/suite-runner')
  const totals = await runSuite({ script: __filename, variants, counts, prepare, afterEach, close, control })
  console.log(`\n${totals.checks - totals.failures} of ${totals.checks} checks passed`)
  process.exit(totals.harness.length ? 2 : totals.failures ? 1 : 0)

  - variants: [{ key, name, run, heading, pool, head, deadline }], in the order they print. `key` names the variant on the command line and in the record (no comma), `name` is what the run says of it, `run()` runs it in this process and reports its checks through the suite's own counters. `heading` is printed above the first of a stretch of variants that share it. Variants of one `pool` share worker processes (a page server and a browser started once for them, the modules they load); a variant with no pool runs in a process of its own. A `head` is run even when `--only` leaves it out. `deadline` is in seconds (the `deadline` of runSuite when it has none).
  - counts(): { checks, failures, extra }: the suite's counters as they stand (`extra` holds any other figures it adds up, by name).
  - prepare(queue): run in each worker before its first variant, with the variants it is to run, each the variant the suite defined (a key `--variants` gives again is handed as the variant of its key): it starts what they need (the page server, warmed, and the browser) and makes what more than one of them reads (the page as it is, a case read in a child). It has the `setup` deadline (seconds), apart from any variant's, which must cover the bounds of what it waits for. Work a variant would do only when it comes first in its worker belongs here: any variant can come first (in a fresh worker, a worker that replaced one that ended, a resumed run, a list `--variants` gives), and its deadline is set for its own work.
  - afterEach(variant): run after each variant in its worker, with the variant the suite defined: it puts back what the variant changed and throws when a trace of it is left (`reset` of scripts/lib/page-server.js). A throw fails that variant and ends the worker, so the next variant starts in a fresh one.
  - close(): run in each worker after its last variant, and also when `prepare` throws or an `afterEach` ends the worker: it puts away whatever `prepare` started, so it copes with a start that got only part of the way. It has the `between` deadline (seconds, 900 unless given) from the moment it begins, however the worker got there (the same deadline bounds a worker between two variants), so that a setup that waits long does not leave a close that hangs unnamed for as long.
  - control: { fault, head }: the keys of a planted fault and of the head. The run adds the control `control:warm-reset`, which runs the fault and then the head in one worker, on the same page server: the fault must be caught and the head must then pass every check, or a trace of the fault survived the reset between them.
  - inputs: the files the suite reads besides the tree (the saves under saves/ and artifacts/, a save named on the command line), as paths from the root or absolute.
  - step(text), exported apart: says where the variant that runs is, on one line (scripts/lib/browser-observe.js `observe` says each step of an observation through it). The parent keeps the last step a variant said, and a deadline that runs out names it ("the variant mutant:74 did not finish in 180 s; the last step it reached: …"). Outside a worker of the runner it does nothing. A suite bounds each step of a variant below the variant's deadline, so that a step that does not end fails by its own timeout, named; the deadline is for what no step bounds.

  Each worker prints its variants between marker lines; the parent hears them as they come, keeps each variant's lines and counts, prints the variants in their order once those before them are done, and adds them up. A variant that runs past its deadline, or whose worker ends while it runs, fails by name as a defect of the harness, is never credited and never counted as passed: its worker is ended with everything it started, nothing it reports once the deadline has passed is heard, and the variants after it go on in a fresh worker. Any other HarnessError a variant throws fails that variant the same way, and its worker goes on. A worker that ends badly between its variants or in its close (a status other than 0, or past the `between` deadline) is a defect of the harness of the run. A worker whose `prepare` throws fails the variants of its queue by name, unrun, with the error it threw, and with the deadline its close then ran past, if it did. After three workers in a row end without finishing a variant, the rest of their queue fails by name without being started. A run with any such failure ends with status 2.

  The record is .check-runs/<script>/progress[-<hash of the arguments>].jsonl in the checkout (ignored by git): a header with the arguments, the hash of the tree (the sources, scripts, fixtures, dependencies and AuroraDB.db), the hash of the inputs (each by its path and its bytes) and the list of variants, then one line for each variant done, with its counts and its lines, and one for each defect of the harness of the run. The last variant of a worker's queue is written once the worker has ended, so a run stopped while a worker closes runs that variant again when resumed. `--resume` takes the variants of the record as done, prints them as they were, reports its defects again and runs the others; it cuts off a line that a stopped run left half written, and it refuses when the tree, the inputs or the list of variants is not the one the record was made for.

  The command line of a script that runs through it, besides its own arguments:
  --resume                    continue the run recorded with the same arguments
  --only=<text>[|<text>...]   the heads and the variants whose names hold one of the texts
  --variants=<key>[,<key>...] exactly these variants, in this order, in one worker (`head` and the others by their keys); a key given again runs again, as the variant `<key>#<n>` of its n-th run
  --worker=<key>[,<key>...]   the runner's own: a worker
*/
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { inParallel, jobs, startChild } = require('./check-pool')

const ROOT = path.resolve(__dirname, '..', '..')
const MARK = '@@suite-runner '
const RUNS = path.join(ROOT, '.check-runs')
const TREE = ['src', 'scripts', 'fixtures', 'package.json', 'bun.lock', 'AuroraDB.db']
const DEATHS = 3
const CONTROL_KEY = 'control:warm-reset'

class RunnerError extends Error {}

const firstLine = (error) => String(error && error.message ? error.message : error).split('\n')[0].slice(0, 600)

// The runner's own arguments taken out of `argv`, and the rest, which the script reads as its own and every worker is given again.
const runnerArgs = (argv = process.argv.slice(2)) => {
  const parsed = { resume: false, only: null, variants: null, worker: null, rest: [] }

  for (const argument of argv) {
    if (argument === '--resume') {
      parsed.resume = true
    } else if (argument.startsWith('--only=')) {
      parsed.only = argument.slice('--only='.length).split('|').filter(Boolean)
    } else if (argument.startsWith('--variants=')) {
      parsed.variants = argument.slice('--variants='.length).split(',').filter(Boolean)
    } else if (argument.startsWith('--worker=')) {
      parsed.worker = argument.slice('--worker='.length).split(',').filter(Boolean)
    } else {
      parsed.rest.push(argument)
    }
  }

  return parsed
}

// The files under `entry` (a file, or a folder read in the order of its names), as paths from the root.
const filesOf = (entry) => {
  const full = path.join(ROOT, entry)

  if (!fs.existsSync(full)) {
    return []
  }

  if (!fs.statSync(full).isDirectory()) {
    return [entry]
  }

  return fs.readdirSync(full).sort().flatMap((name) => filesOf(path.join(entry, name)))
}

const CHUNK = Buffer.allocUnsafe(1 << 20)

// Adds the bytes of `file` to `hash` a chunk at a time, so that a save is never held whole.
const hashFile = (hash, file) => {
  const handle = fs.openSync(file, 'r')

  try {
    for (let read = fs.readSync(handle, CHUNK, 0, CHUNK.length, null); read > 0; read = fs.readSync(handle, CHUNK, 0, CHUNK.length, null)) {
      hash.update(CHUNK.subarray(0, read))
    }
  } finally {
    fs.closeSync(handle)
  }
}

// The hash of what a run's results depend on: each file of TREE by its path and its bytes.
const treeHash = () => {
  const hash = crypto.createHash('sha256')

  for (const file of TREE.flatMap(filesOf)) {
    hash.update(file.replace(/\\/g, '/')).update('\0')
    hashFile(hash, path.join(ROOT, file))
    hash.update('\0')
  }

  return hash.digest('hex')
}

// The hash of the inputs: each by its path and its bytes, or as missing.
const inputsHash = (inputs) => {
  const hash = crypto.createHash('sha256')

  for (const input of inputs.map((file) => path.resolve(ROOT, file)).sort()) {
    const present = fs.existsSync(input)

    hash.update(path.relative(ROOT, input).replace(/\\/g, '/')).update(present ? '\0present\0' : '\0missing\0')

    if (present) {
      hashFile(hash, input)
    }
  }

  return hash.digest('hex')
}

const recordOf = (script, args) => path.join(RUNS, path.basename(script, '.js'), `progress${args.length ? `-${crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 10)}` : ''}.jsonl`)

// The record of an earlier run with these arguments: its header, its variants by key, its defects of the run and the length in bytes of its whole lines. Throws a RunnerError when there is none, or when it was made for another tree, other inputs or another list of variants.
const readRecord = (file, header) => {
  if (!fs.existsSync(file)) {
    throw new RunnerError(`--resume: there is no record of a run with these arguments (${path.relative(ROOT, file)})`)
  }

  const text = fs.readFileSync(file, 'utf8')
  // A line that a stopped run left half written has no line break at its end: it is no result.
  const whole = text.slice(0, text.lastIndexOf('\n') + 1)
  const [first, ...lines] = whole.split('\n').filter(Boolean)
  const kept = JSON.parse(first)

  if (kept.tree !== header.tree) {
    throw new RunnerError(`--resume: the tree changed since the run of ${kept.began} began (the sources, scripts, fixtures, dependencies or AuroraDB.db differ); start the run again without --resume`)
  }

  if (kept.inputs !== header.inputs) {
    throw new RunnerError(`--resume: a save the suite reads changed since the run of ${kept.began} began; start the run again without --resume`)
  }

  if (JSON.stringify(kept.variants) !== JSON.stringify(header.variants)) {
    throw new RunnerError(`--resume: the list of variants changed since the run of ${kept.began} began; start the run again without --resume`)
  }

  const done = new Map()
  const problems = []

  for (const entry of lines.map((line) => JSON.parse(line))) {
    if (entry.problem) {
      problems.push(entry.problem)
    }

    if (entry.key) {
      done.set(entry.key, entry)
    }
  }

  return { began: kept.began, done, problems, size: Buffer.byteLength(whole) }
}

const sum = (into, extra = {}) => {
  for (const [name, value] of Object.entries(extra)) {
    into[name] = (into[name] || 0) + value
  }

  return into
}

const delta = (before, after) => ({ checks: after.checks - before.checks, failures: after.failures - before.failures, extra: Object.fromEntries(Object.entries(after.extra || {}).map(([name, value]) => [name, value - ((before.extra || {})[name] || 0)])) })

// ---------- a worker ----------

// The worker's own console.log, kept as the module loads: the control puts another in its place while it keeps the lines of its two steps back, and a marker must still reach the parent, in order with the lines around it.
const log = console.log.bind(console)
let inWorker = false

const say = (text) => log(`${MARK}${text}`)

// Says where the variant that runs is (its step, on one line): the parent keeps the last one, and a deadline that runs out names it. Nothing outside a worker.
const step = (text) => {
  if (inWorker) {
    say(`step ${String(text).split('\n')[0].slice(0, 300)}`)
  }
}

// The control: the fault and then the head, in this worker, each followed by `afterEach`, their lines kept back; one check of its own.
const runControl = async (variant, { counts, afterEach }) => {
  const lines = []
  const restore = console.log
  const runOne = async (target) => {
    const before = counts()

    await target.run()
    await afterEach(target)

    return delta(before, counts())
  }
  let planted
  let cleared

  console.log = (...parts) => { lines.push(parts.map(String).join(' ')) }

  try {
    planted = await runOne(variant.control.fault)
    cleared = await runOne(variant.control.head)
  } finally {
    console.log = restore
  }

  const ok = planted.checks > 0 && planted.failures === 0 && cleared.checks > 0 && cleared.failures === 0

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${variant.name}${ok ? `  [the fault caught, then the head ${cleared.checks} of ${cleared.checks}]` : ` (the fault: ${planted.failures} of ${planted.checks} failed; the head after it: ${cleared.failures} of ${cleared.checks} failed: ${lines.filter((line) => line.startsWith('FAIL')).slice(0, 3).join(' | ').slice(0, 800)})`}`)

  return { checks: 1, failures: ok ? 0 : 1, extra: {} }
}

// The variant the suite defined: a key `--variants` gives again runs as a variant of the runner's own (`runOf`), and the suite's hooks are handed the variant of its key, which they know.
const defined = (variant) => variant.of || variant

// A worker: `prepare`, then each variant of its queue between marker lines, then `close`, which also runs when `prepare` throws or an `afterEach` ends the worker, so that what `prepare` started is put away. A `prepare` that throws is said before the close, so that a close that hangs does not hide it, and the close is said as it begins, so that the parent bounds it by the `between` deadline however the worker got there.
const work = async (queue, { counts, prepare, afterEach, close }) => {
  let code = 0

  try {
    try {
      await prepare(queue.map(defined))
    } catch (error) {
      say(`unprepared ${firstLine(error)}`)
      throw error
    }

    say('ready')

    for (const variant of queue) {
      say(`begin ${variant.key}`)

      const before = counts()
      let own = null
      let harness = null
      let fatal = false

      try {
        if (variant.control) {
          own = await runControl(variant, { counts, afterEach })
        } else {
          await variant.run()
        }
      } catch (error) {
        harness = firstLine(error)
        console.log(`FAIL  ${variant.name} (a defect of the harness: ${harness})`)
      }

      try {
        await afterEach(defined(variant))
      } catch (error) {
        fatal = true
        harness = harness || `after the variant: ${firstLine(error)}`
        console.log(`FAIL  ${variant.name} (a defect of the harness after it: ${firstLine(error)})`)
      }

      const counted = own ? { ...own, failures: harness ? own.checks : own.failures } : delta(before, counts())

      if (harness && !own) {
        counted.checks++
        counted.failures++
      }

      say(`end ${JSON.stringify({ key: variant.key, ...counted, harness })}`)

      if (fatal) {
        code = 4
        break
      }
    }
  } finally {
    say('closing')
    await close()
  }

  process.exit(code)
}

// ---------- the parent ----------

// The queues of workers: the variants of each pool dealt round robin to as many workers as run at once, in their order, and each variant without a pool in a queue of its own; `--variants` puts its variants in one queue, in its order.
const queuesOf = (selected, ordered) => {
  if (ordered) {
    return [selected]
  }

  const queues = []
  const pools = new Map()

  for (const variant of selected) {
    if (!variant.pool) {
      queues.push([variant])
    } else {
      pools.set(variant.pool, [...(pools.get(variant.pool) || []), variant])
    }
  }

  for (const list of pools.values()) {
    const count = Math.min(jobs(), list.length)

    queues.push(...Array.from({ length: count }, (_none, at) => list.filter((_variant, place) => place % count === at)))
  }

  return queues
}

const supervise = async ({ script, byKey, selected, args, ordered, resume, setup, between, workerArgs, inputs }) => {
  const file = recordOf(script, args)
  const header = { script: path.relative(ROOT, script).replace(/\\/g, '/'), args, tree: treeHash(), inputs: inputsHash(inputs), variants: selected.map(({ key, name }) => [key, name]), began: new Date().toISOString() }
  const resumed = resume ? readRecord(file, header) : null
  const results = new Map(resumed ? [...resumed.done].filter(([key]) => byKey.has(key)) : [])
  const problems = resumed ? [...resumed.problems] : []
  const live = new Set()
  let printed = 0
  let heading = null

  fs.mkdirSync(path.dirname(file), { recursive: true })

  if (resumed) {
    fs.truncateSync(file, resumed.size)
  } else {
    fs.writeFileSync(file, `${JSON.stringify(header)}\n`)
  }

  console.log(`The record of this run: ${path.relative(ROOT, file)}${resumed ? `, resumed: ${results.size} of ${selected.length} variants done in the run of ${resumed.began}` : ''} (--resume continues it)`)

  const flush = () => {
    while (printed < selected.length && results.has(selected[printed].key)) {
      const variant = selected[printed++]
      const result = results.get(variant.key)

      if ((variant.heading || null) !== heading) {
        heading = variant.heading || null

        if (heading) {
          console.log(heading)
        }
      }

      if (result.output.length) {
        console.log(result.output.join('\n'))
      }
    }
  }
  // A variant done, and with it the defect of its worker when the worker ended badly after it: one line of the record, so that a record cut off holds both or neither.
  const keep = (result, defect = null) => {
    results.set(result.key, result)

    if (defect) {
      problems.push(defect)
    }

    fs.appendFileSync(file, `${JSON.stringify(defect ? { ...result, problem: defect } : result)}\n`)
    flush()
  }
  const failed = (variant, reason, output = [], seconds = 0) => keep({ key: variant.key, name: variant.name, checks: 1, failures: 1, extra: {}, harness: reason, seconds, output: [...output, `FAIL  ${variant.name} (a defect of the harness: ${reason})`] })
  // A defect of the harness of the run rather than of a variant, kept in the record so that a resumed run reports it again.
  const problem = (text) => {
    problems.push(text)
    fs.appendFileSync(file, `${JSON.stringify({ problem: text })}\n`)
  }
  const stop = () => live.forEach((handle) => handle.kill())

  process.on('exit', stop)
  ;['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((signal) => process.on(signal, () => {
    stop()
    process.exit(130)
  }))

  // One worker over `queue`, until it ends: what it did and how it ended.
  const runWorker = (queue) => new Promise((resolve) => {
    const done = []
    let pending = []
    let current = null
    let ready = false
    let reason = null
    let timer = null
    let last = null
    // What a `prepare` that threw said of its error, or null: the variants of the queue fail by it, whatever the close then does.
    let unprepared = null
    // The last step the worker said since it started or its last variant began or ended or its close began, or null: a deadline that runs out names it, so a variant is never named with the step of its setup or of the variant before it, nor the close with the step of the last variant.
    let reached = null
    const arm = (seconds, what) => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        reason = `${what} did not finish in ${seconds} s${reached ? `; the last step it reached: ${reached}` : ''}`
        handle.kill()
      }, seconds * 1000)
    }
    const onLine = (line, stream) => {
      // Once a deadline has passed the worker's end is decided: nothing it says after that is heard, the end of a variant that finished late among it.
      if (reason) {
        return
      }

      if (stream === 'stdout' && line.startsWith(MARK)) {
        const text = line.slice(MARK.length)
        const space = text.indexOf(' ')
        const word = space === -1 ? text : text.slice(0, space)
        const body = space === -1 ? '' : text.slice(space + 1)

        if (word === 'ready') {
          ready = true
          clearTimeout(timer)
        } else if (word === 'unprepared') {
          unprepared = body
        } else if (word === 'closing') {
          // The close is bounded by the `between` deadline from the moment it begins: after the last variant, after an `afterEach` that ended the worker, or after a `prepare` that threw, whose `setup` deadline no longer bounds it.
          reached = null
          arm(between, 'the close of the worker')
        } else if (word === 'step') {
          reached = body
        } else if (word === 'begin') {
          const variant = byKey.get(body)

          current = { variant, began: Date.now(), lines: pending }
          reached = null
          pending = []
          arm(variant.deadline, `the variant ${variant.key}`)
        } else if (word === 'end') {
          const result = JSON.parse(body)
          const kept = { ...result, name: current.variant.name, seconds: (Date.now() - current.began) / 1000, output: current.lines }

          done.push(result.key)
          current = null
          reached = null

          // The last variant of the queue is kept once its worker has ended: a run stopped in the close runs it again when resumed, so that the close is seen to end.
          if (done.length === queue.length) {
            last = kept
          } else {
            keep(kept)
          }

          // Between two variants the worker is bounded too, by the `between` deadline, until the next variant or its close begins.
          arm(between, `the worker after the variant ${result.key}`)
        }

        return
      }

      (current ? current.lines : pending).push(line)
    }
    const handle = startChild(script, [...workerArgs, `--worker=${queue.map(({ key }) => key).join(',')}`], { onLine })

    live.add(handle)
    arm(setup, 'the setup of the worker')
    handle.done.then(({ code, stderr }) => ({ code, stderr }), (error) => ({ code: null, stderr: firstLine(error) })).then(({ code, stderr }) => {
      clearTimeout(timer)
      live.delete(handle)
      resolve({ done, current, last, ready, unprepared, expired: Boolean(reason), reason: reason || `the worker ended with status ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 600)}` : ''}`, code, pending })
    })
  })

  const runQueue = async (queue) => {
    let rest = queue.filter(({ key }) => !results.has(key))
    let deaths = 0

    while (rest.length) {
      const ended = await runWorker(rest)

      if (!ended.ready) {
        const why = ended.unprepared ? `the setup failed: ${ended.unprepared}${ended.expired ? `; ${ended.reason}` : ''}` : `${ended.reason} during its setup`

        rest.forEach((variant) => failed(variant, `not run: ${why}`, ended.pending))

        return
      }

      // Status 4 is a worker that a failed reset ended, which that variant already carries.
      const defect = !ended.current && (ended.expired || ![0, 4].includes(ended.code)) ? `a worker ended badly ${ended.done.length ? `after the variant ${ended.done[ended.done.length - 1]}` : 'before its first variant'}: ${ended.reason}` : null

      if (ended.current) {
        failed(ended.current.variant, ended.reason, ended.current.lines, (Date.now() - ended.current.began) / 1000)
      } else if (ended.last) {
        keep(ended.last, defect)
      } else if (defect) {
        problem(defect)
      }

      deaths = ended.done.length ? 0 : deaths + 1
      rest = rest.filter(({ key }) => !results.has(key))

      if (rest.length && deaths >= DEATHS) {
        rest.forEach((variant) => failed(variant, `not run: ${DEATHS} workers in a row ended without finishing a variant, the last as ${ended.reason}`))

        return
      }
    }
  }

  flush()

  const queues = queuesOf(selected, ordered).filter((queue) => queue.some(({ key }) => !results.has(key)))
  const limit = ordered ? 1 : jobs()
  const weight = (queue) => queue.reduce((total, variant) => total + variant.deadline, 0)
  const place = new Map(selected.map(({ key }, at) => [key, at]))

  // Side by side, the longest queues start first, so no long one starts last; one at a time, they run in the order they print, so the record and the output grow from the top.
  await inParallel([...queues].sort((a, b) => (limit === 1 ? place.get(a[0].key) - place.get(b[0].key) : weight(b) - weight(a))), runQueue, limit)
  flush()
  process.off('exit', stop)

  const totals = { checks: 0, failures: 0, extra: {}, harness: [], problems }

  for (const variant of selected) {
    const result = results.get(variant.key)

    totals.checks += result.checks
    totals.failures += result.failures
    sum(totals.extra, result.extra)

    if (result.harness) {
      totals.harness.push(`${variant.key}: ${result.harness}`)
    }
  }

  totals.harness.push(...problems)

  const timed = selected.map(({ key }) => results.get(key)).filter((result) => result.seconds > 0).sort((a, b) => b.seconds - a.seconds)

  console.log(`\nThe slowest variants: ${timed.slice(0, 5).map((result) => `${result.key} ${result.seconds.toFixed(1)} s`).join(', ') || 'none timed'}`)

  if (totals.harness.length) {
    console.log(`Defects of the harness (status 2):\n${totals.harness.map((line) => `  ${line}`).join('\n')}`)
  }

  return totals
}

// The list with the control added, checked for keys and names that repeat.
const listOf = (variants, control, deadline) => {
  const list = variants.map((variant) => ({ ...variant, deadline: variant.deadline || deadline }))
  const byKey = new Map(list.map((variant) => [variant.key, variant]))

  if (control) {
    const fault = byKey.get(control.fault)
    const head = byKey.get(control.head)

    if (!fault || !head) {
      throw new RunnerError(`the control names a variant the suite does not have: ${!fault ? control.fault : control.head}`)
    }

    const added = { key: CONTROL_KEY, name: `control: the head, run on the same page server after the variant "${fault.name}", passes every check, so no trace of the fault survives`, heading: control.heading || null, pool: fault.pool, deadline: fault.deadline + head.deadline, control: { fault, head } }

    list.push(added)
    byKey.set(added.key, added)
  }

  const repeated = list.filter((variant, at) => list.findIndex((other) => other.key === variant.key || other.name === variant.name) !== at).map(({ key }) => key)

  if (repeated.length || list.some(({ key }) => /[,\s]/.test(key))) {
    throw new RunnerError(`variants repeat a key or a name, or have a key with a comma or a space: ${repeated.join(', ')}`)
  }

  return { list, byKey }
}

// The keys of `--variants` with each key given again numbered by its run (`mutant:91`, `mutant:91#2`, `mutant:91#3`), and the variant of such a key: the variant of its own key, or the n-th run of one as a variant of its own, so that a variant that fails once in a while can be run over and over, side by side with others, in one worker.
const numbered = (keys) => keys.map((key, at) => {
  const run = keys.slice(0, at).filter((other) => other === key).length + 1

  return run === 1 ? key : `${key}#${run}`
})
const runOf = (byKey, key) => {
  const again = byKey.has(key) ? null : /^(.+)#(\d+)$/.exec(key)
  const variant = byKey.get(again ? again[1] : key)

  return variant && again ? { ...variant, key, name: `${variant.name} (run ${again[2]})`, of: variant } : variant
}

const runSuite = async ({ script, variants, counts, prepare = async () => {}, afterEach = async () => {}, close = async () => {}, control = null, inputs = [], deadline = 300, setup = 900, between = 900, argv = process.argv.slice(2) }) => {
  const parsed = runnerArgs(argv)
  const { list, byKey } = listOf(variants, control, deadline)

  if (parsed.worker) {
    inWorker = true

    const queue = parsed.worker.map((key) => runOf(byKey, key))

    if (queue.some((variant) => !variant)) {
      throw new RunnerError(`a worker was given a key the suite does not have: ${parsed.worker.join(',')}`)
    }

    try {
      await work(queue, { counts, prepare, afterEach, close })
    } catch (error) {
      console.error(error)
      process.exit(3)
    }
  }

  if (parsed.only && parsed.variants) {
    throw new RunnerError('--only and --variants do not go together')
  }

  const missing = (parsed.variants || []).filter((key) => !byKey.has(key))

  if (missing.length) {
    throw new RunnerError(`no variant has the key ${missing.join(', ')}; the keys are ${list.map(({ key }) => key).join(', ')}`)
  }

  const selected = parsed.variants ? numbered(parsed.variants).map((key) => runOf(byKey, key)) : parsed.only ? list.filter((variant) => variant.head || parsed.only.some((text) => variant.name.includes(text))) : list
  const args = [...parsed.rest, ...(parsed.only ? [`--only=${parsed.only.join('|')}`] : []), ...(parsed.variants ? [`--variants=${parsed.variants.join(',')}`] : [])]

  return supervise({ script, byKey: new Map([...byKey, ...selected.map((variant) => [variant.key, variant])]), selected, args, ordered: Boolean(parsed.variants), resume: parsed.resume, setup, between, workerArgs: parsed.rest, inputs })
}

module.exports = { runSuite, runnerArgs, step, treeHash, RunnerError, CONTROL_KEY }
