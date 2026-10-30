// Runs the independent work of a check script (its mutants, mostly) several at a time. Each mutant already runs in a fresh copy of the modules, and the slow scripts spend most of their time on mutants one after another, so running them side by side cuts the wall time by about the number of cores without changing what any check or mutant proves.
// `CHECK_JOBS` sets how many run at once (scripts/check-all.js divides its budget between the scripts it runs); without it, half the logical processors, at least one. The checks are JavaScript: a second hardware thread on a core adds little to one that is busy, and every worker holds a copy of the modules and often a copied source tree, so more workers than physical cores only adds memory and disk traffic and leaves nothing for the rest of the machine.
const os = require('os')
const { spawn, spawnSync } = require('child_process')

const threads = () => (os.availableParallelism ? os.availableParallelism() : os.cpus().length)

const cores = () => Math.max(1, Math.floor(threads() / 2))

const jobs = () => {
  const set = Number(process.env.CHECK_JOBS)

  return Number.isInteger(set) && set > 0 ? set : cores()
}

// `items` through `work`, no more than `limit` at a time; the results in the order of the items. A work that throws gives its error as its result, so one failure never hides the others.
const inParallel = async (items, work, limit = jobs()) => {
  const results = new Array(items.length)
  let next = 0

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++

      try {
        results[index] = await work(items[index], index)
      } catch (error) {
        results[index] = error instanceof Error ? error : new Error(String(error))
      }
    }
  }))

  return results
}

// Ends the process `pid` and every process it started (a worker's Chromium and esbuild with it), at once: on Windows a process that is ended leaves its children running, so the whole tree goes through taskkill; elsewhere the child is sent SIGKILL, and Chromium ends when the pipe of the process that launched it closes.
const killTree = (pid) => {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch (error) {
    // Gone already.
  }
}

// Starts `script` again with `args` in a process of its own (the runtime this one runs on) and returns { pid, kill, done }: `kill()` ends it and everything it started (`killTree`), `done` resolves { code, stdout, stderr, timedOut } when it has ended, and `onLine(line, stream)`, when given, hears each line as it is printed. `limit` (ms), when given, bounds the child: once it has run that long it is ended with everything it started, `timedOut` is true, `code` is null and its stderr ends with a line that says so, so that a caller that starts children one after another knows the longest each can take. The code is null whatever status the child ended with while it was being ended (one that finishes as taskkill starts ends with its own), so a child past its limit never reads as one that succeeded. A child gets CHECK_JOBS=1, so its own pools do not multiply the processes, and BUN_RUNTIME_TRANSPILER_CACHE_PATH=0, so Bun keeps no transpiled copy of what it loads: a child loads the modules of one mutant (or one script of a run) once, Bun keeps every copy in its cache folder for good and never removes one, and the mutants of a few days of checks filled it with 485 GiB. The variable only counts in the environment a process starts with (Bun reads it neither from process.env set later nor from a .env file), so it is set here, where the child starts; `env` cannot turn the cache back on.
const startChild = (script, args = [], { env = {}, maxBuffer = 1 << 28, onLine = null, limit = 0 } = {}) => {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, CHECK_JOBS: '1', ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let timedOut = false
  const timer = limit ? setTimeout(() => {
    timedOut = true
    killTree(child.pid)
  }, limit) : null
  const kept = { stdout: '', stderr: '' }
  const partial = { stdout: '', stderr: '' }
  const hear = (stream) => (text) => {
    kept[stream] += text

    if (stream === 'stdout' && kept.stdout.length > maxBuffer) {
      killTree(child.pid)
    }

    if (onLine) {
      const lines = (partial[stream] + text).split(/\r?\n/)

      partial[stream] = lines.pop()
      lines.forEach((line) => onLine(line, stream))
    }
  }
  const done = new Promise((resolve, reject) => {
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)

      if (onLine) {
        ['stdout', 'stderr'].filter((stream) => partial[stream] !== '').forEach((stream) => onLine(partial[stream], stream))
      }

      resolve({ code: timedOut ? null : code, stdout: kept.stdout, stderr: timedOut ? `${kept.stderr}\nthe child did not finish in ${limit / 1000} s\n` : kept.stderr, timedOut })
    })
  })

  child.stdout.setEncoding('utf8').on('data', hear('stdout'))
  child.stderr.setEncoding('utf8').on('data', hear('stderr'))

  return { pid: child.pid, kill: () => killTree(child.pid), done }
}

// `startChild` run to its end: resolves { code, stdout, stderr, timedOut }.
const runChild = (script, args = [], options = {}) => startChild(script, args, options).done

// The JSON a child printed on its last line that starts with `prefix`, or an error naming how the child ended.
const lastJson = ({ code, stdout, stderr }, prefix = '') => {
  const line = stdout.split('\n').map((row) => row.trim()).filter((row) => row.startsWith(prefix) && row.length > prefix.length).pop()

  if (line === undefined) {
    throw new Error(`the child ended with status ${code} and printed no result: ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`)
  }

  return JSON.parse(line.slice(prefix.length))
}

module.exports = { cores, jobs, inParallel, startChild, runChild, killTree, lastJson }
