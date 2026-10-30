/*
  Starts a run of a check script that outlives the shell, the job or the agent's turn that started it, and reads how it went.

  bun scripts/run-check.js start [--label=<name>] <script> [arguments...]   starts the run and returns at once
  bun scripts/run-check.js status [<name>]                                 what the run is doing, or how it ended (every run when no name is given)
  bun scripts/run-check.js wait <name>                                     waits until the run ends, prints how it ended and ends with its status

  <script> is a check script by its path or its name (`resource-ledger`, `check-resource-ledger.js`); <name> is its name or the label given at the start. `start` launches a supervisor that is detached from the starting process and no longer its child once `start` returns, so ending the starter's process tree (as a shell, a job runner or an agent does when its turn ends) leaves the run going. The supervisor runs the script with CHECK_JOBS=1 unless the environment sets it (a full run is a heavy job), writes everything it prints to .check-runs/<name>/log.txt, keeps .check-runs/<name>/status.json up to date (state, the processes, the time, the last line, the peak memory so far) and writes the status, the summary line and the peak memory there when the script ends. One run of a name at a time: `start` refuses while one is going or starting.

  The status has one writer at a time. `start` writes it before launch. The supervisor writes its pid and commits startup before it starts the script; from that commitment on the supervisor alone writes status. The starter writes again only after confirmed supervisor exit without committed startup, recording `failed` with why. A starter must never put back a status the supervisor has moved on from.

  The starter creates `.check-runs/<name>/startup.pending` before launch. After its first status write, the supervisor atomically removes this token to commit startup, then starts work. On startup expiry the starter competes to remove the same token and may terminate only if it wins. Thus a stalled publication remains bounded, a supervisor that loses starts no work, and a stale pre-publication snapshot cannot authorize killing committed work.

  Peak memory is sampled every 5 s over the script's whole process tree (the workers, Chromium, esbuild): the most the tree held at once (the sum of the working sets) and the most one process of it held (its peak working set, which Windows keeps for each process). A process belongs to the tree only when it was created no earlier than the member it names as its parent: Windows reuses the PID of a process that has ended, so an unrelated process whose parent ended can name a member's PID.

  A run that was stopped (the supervisor killed, the machine restarted) is continued with `start <script> --resume` when the script runs through scripts/lib/suite-runner.js.
*/
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { startChild, killTree } = require('./lib/check-pool')

const ROOT = path.resolve(__dirname, '..')
const RUNS = path.join(ROOT, '.check-runs')
const SAMPLE_SECONDS = 5
// How long `start` waits for the supervisor's first write, and how long a run whose starter has written the status and whose supervisor has not is taken to be starting.
const STARTUP_SECONDS = 60
const POLL_MS = 100

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const alive = (pid) => {
  try {
    process.kill(pid, 0)

    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

const scriptOf = (given) => {
  const candidates = [path.resolve(given), path.join(__dirname, given), path.join(__dirname, `${given}.js`), path.join(__dirname, `check-${given}.js`)]
  const found = candidates.find((file) => fs.existsSync(file) && fs.statSync(file).isFile())

  if (!found) {
    throw new Error(`no check script is named ${given}`)
  }

  return found
}

const nameOf = (script) => path.basename(script, '.js')
const folderOf = (name) => path.join(RUNS, name)
const statusFile = (name) => path.join(folderOf(name), 'status.json')
const readStatus = (name) => (fs.existsSync(statusFile(name)) ? JSON.parse(fs.readFileSync(statusFile(name), 'utf8')) : null)
const startupFile = (name) => path.join(folderOf(name), 'startup.pending')

// Exactly one contender can consume the launch token: the supervisor after its first status write, or the starter on startup expiry. Work starts only after supervisor consumption; a failed or stalled write leaves the token available to the deadline.
const takeStartup = (name) => {
  try {
    fs.unlinkSync(startupFile(name))

    return true
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }

    return false
  }
}

const writeStatus = (name, status) => {
  const file = statusFile(name)

  fs.writeFileSync(`${file}.next`, `${JSON.stringify(status, null, 2)}\n`)
  fs.renameSync(`${file}.next`, file)
}

// A run that says it is going and whose supervisor is alive.
const going = (status) => Boolean(status) && ['starting', 'running'].includes(status.state) && alive(status.supervisor)

// A run whose starter has written the status and whose supervisor has not written it yet, for less than STARTUP_SECONDS.
const starting = (status) => Boolean(status) && status.state === 'starting' && !status.supervisor && Date.now() - Date.parse(status.started) < STARTUP_SECONDS * 1000

const megabytes = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`

const describe = (name, status) => {
  if (!status) {
    return `${name}: no run`
  }

  const lost = ['starting', 'running'].includes(status.state) && !alive(status.supervisor) && !starting(status)
  const seconds = status.seconds !== undefined ? status.seconds : (Date.now() - Date.parse(status.started)) / 1000
  const peak = status.peak ? `, peak ${megabytes(status.peak.tree)} for the tree, ${megabytes(status.peak.process)} for one process (${status.peak.name})` : ''

  return [
    `${name}: ${lost ? 'lost (its supervisor is gone; start it again, with --resume to continue)' : status.state}${status.code !== undefined ? ` with status ${status.code}` : ''} after ${seconds.toFixed(0)} s${peak}`,
    `  ${[status.script, ...status.args].join(' ')}`,
    `  ${status.summary || status.last || ''}`,
    `  log: ${path.join(folderOf(name), 'log.txt')}`,
  ].join('\n')
}

// Samples the process tree under `pid` every SAMPLE_SECONDS and hands each sample to `heard` as { tree, process, name }: the sum of the working sets and the largest peak working set of one process, in bytes. Returns the sampler, to kill.
// On Windows a process whose parent has ended keeps that parent's PID, which a newer process can be given, so a child counts only when it was created no earlier than the member it names; the times are compared in UTC, as local times repeat when the clocks go back, and the child of a member whose creation is unknown is left out. Elsewhere such a process is handed to init, so its parent PID always names its parent.
const sampleTree = (pid, heard) => {
  if (process.platform === 'win32') {
    const script = `$root = ${pid}; while ($true) { $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,WorkingSetSize,PeakWorkingSetSize,Name; $byParent = @{}; foreach ($p in $all) { $k = [int]$p.ParentProcessId; if (-not $byParent.ContainsKey($k)) { $byParent[$k] = @() }; $byParent[$k] += $p }; $queue = @($all | Where-Object { $_.ProcessId -eq $root }); $sum = 0; $peak = 0; $name = ''; $seen = @{}; while ($queue.Count -gt 0) { $p = $queue[0]; $queue = @($queue | Select-Object -Skip 1); if ($seen.ContainsKey([int]$p.ProcessId)) { continue }; $seen[[int]$p.ProcessId] = $true; $sum += [int64]$p.WorkingSetSize; $one = [int64]$p.PeakWorkingSetSize * 1024; if ($one -gt $peak) { $peak = $one; $name = $p.Name }; if ($byParent.ContainsKey([int]$p.ProcessId)) { $queue += @($byParent[[int]$p.ProcessId] | Where-Object { $_.CreationDate.ToUniversalTime() -ge $p.CreationDate.ToUniversalTime() }) } }; Write-Output "SAMPLE $sum $peak $name"; Start-Sleep -Seconds ${SAMPLE_SECONDS} }`
    const sampler = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let partial = ''

    sampler.stdout.setEncoding('utf8').on('data', (text) => {
      const lines = (partial + text).split(/\r?\n/)

      partial = lines.pop()
      lines.map((line) => /^SAMPLE (\d+) (\d+) (.*)$/.exec(line.trim())).filter(Boolean).forEach(([, tree, one, name]) => heard({ tree: Number(tree), process: Number(one), name }))
    })

    return { stop: () => sampler.kill() }
  }

  const peaks = new Map()
  const timer = setInterval(() => {
    const rows = require('child_process').execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' }).trim().split('\n').map((line) => line.trim().split(/\s+/)).map(([id, parent, rss, ...name]) => ({ id: Number(id), parent: Number(parent), bytes: Number(rss) * 1024, name: name.join(' ') }))
    const inTree = new Set([pid])
    let grew = true

    while (grew) {
      grew = false
      rows.filter((row) => !inTree.has(row.id) && inTree.has(row.parent)).forEach((row) => {
        inTree.add(row.id)
        grew = true
      })
    }

    const members = rows.filter((row) => inTree.has(row.id))

    members.forEach((row) => peaks.set(row.id, Math.max(peaks.get(row.id) || 0, row.bytes)))

    const largest = members.reduce((best, row) => (peaks.get(row.id) > best.bytes ? { bytes: peaks.get(row.id), name: row.name } : best), { bytes: 0, name: '' })

    heard({ tree: members.reduce((total, row) => total + row.bytes, 0), process: largest.bytes, name: largest.name })
  }, SAMPLE_SECONDS * 1000)

  return { stop: () => clearInterval(timer) }
}

const supervise = async (name, script, args) => {
  if (!fs.existsSync(startupFile(name))) {
    throw new Error('startup was cancelled before supervisor publication')
  }

  // Publish before committing startup: the token still bounds a stalled read or write here. A timeout winner may replace this status only once the supervisor has exited.
  const status = { ...readStatus(name), state: 'running', supervisor: process.pid }

  writeStatus(name, status)

  if (!takeStartup(name)) {
    throw new Error('startup was cancelled before supervisor commitment')
  }

  const folder = folderOf(name)
  const log = fs.openSync(path.join(folder, 'log.txt'), 'w')
  const began = Date.now()
  let last = ''
  let written = 0
  const save = () => {
    written = Date.now()
    writeStatus(name, { ...status, last, seconds: undefined })
  }
  const child = startChild(script, args, {
    env: { CHECK_JOBS: process.env.CHECK_JOBS || '1' },
    maxBuffer: Infinity,
    onLine: (line) => {
      fs.writeSync(log, `${line}\n`)

      if (line.trim()) {
        last = line.trim().slice(0, 300)
      }
    },
  })

  status.child = child.pid
  save()

  const sampler = sampleTree(child.pid, (sample) => {
    const peak = status.peak || { tree: 0, process: 0, name: '' }

    status.peak = { tree: Math.max(peak.tree, sample.tree), ...(sample.process >= peak.process ? { process: sample.process, name: sample.name } : { process: peak.process, name: peak.name }) }

    if (Date.now() - written > SAMPLE_SECONDS * 1000) {
      save()
    }
  })
  const { code } = await child.done.catch((error) => ({ code: null, error }))
  const lines = fs.readFileSync(path.join(folder, 'log.txt'), 'utf8').split('\n').map((line) => line.trim()).filter(Boolean)

  sampler.stop()
  fs.closeSync(log)
  writeStatus(name, { ...status, state: 'done', code, seconds: (Date.now() - began) / 1000, ended: new Date().toISOString(), summary: lines.filter((line) => /\bchecks? passed\b/.test(line)).pop() || lines.pop() || '' })
}

const start = async (argv) => {
  const label = argv[0] && argv[0].startsWith('--label=') ? argv.shift().slice('--label='.length) : null
  const script = scriptOf(argv.shift() || '')
  const name = label || nameOf(script)
  const before = readStatus(name)

  if (going(before) || starting(before)) {
    throw new Error(`a run of ${name} is ${before.supervisor ? `going already (supervisor ${before.supervisor})` : 'starting'}; wait for it or end it first`)
  }

  const began = Date.now()

  fs.mkdirSync(folderOf(name), { recursive: true })
  fs.writeFileSync(startupFile(name), '')
  writeStatus(name, { state: 'starting', script: path.relative(ROOT, script).replace(/\\/g, '/'), args: argv, started: new Date(began).toISOString(), supervisor: null })

  const supervisor = spawn(process.execPath, [__filename, 'supervise', name, script, ...argv], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true })
  let exited = null
  let late = false
  let startupExpired = false

  supervisor.once('exit', (code) => {
    exited = { code }
  })

  // A matching pid alone is not commitment: the first write can precede cancellation. Only a consumed token not taken by this starter acknowledges startup. An exit heard during a pause precedes the following status read, so an uncommitted supervisor can no longer write when failure is saved.
  let ended = null
  let seen = readStatus(name)
  const published = () => !late && seen.supervisor === supervisor.pid && !fs.existsSync(startupFile(name))

  while (!published() && !ended) {
    if (!startupExpired && Date.now() - began > STARTUP_SECONDS * 1000) {
      startupExpired = true

      if (takeStartup(name)) {
        late = true
        killTree(supervisor.pid)
      }
    }

    await pause(POLL_MS)
    ended = exited
    seen = readStatus(name)
  }

  if (!published()) {
    const why = late ? `the supervisor did not publish startup in ${STARTUP_SECONDS} s and was ended` : `the supervisor ended with status ${ended.code} before it published startup`

    writeStatus(name, { ...seen, state: 'failed', supervisor: supervisor.pid, code: null, seconds: (Date.now() - began) / 1000, ended: new Date().toISOString(), summary: why })

    throw new Error(`${name} did not start: ${why}`)
  }

  supervisor.unref()

  console.log(`started ${name} (supervisor ${supervisor.pid}): ${[path.relative(ROOT, script), ...argv].join(' ')}`)
  console.log(`  log:    ${path.join(folderOf(name), 'log.txt')}`)
  console.log(`  status: bun scripts/run-check.js status ${name}`)
  console.log(`  wait:   bun scripts/run-check.js wait ${name}`)
}

const status = (argv) => {
  const names = argv.length ? argv : (fs.existsSync(RUNS) ? fs.readdirSync(RUNS).filter((name) => fs.existsSync(statusFile(name))) : [])

  if (!names.length) {
    console.log('no runs')
  }

  names.forEach((name) => console.log(describe(name, readStatus(name))))
}

const wait = async (argv) => {
  const name = argv[0]

  if (!readStatus(name)) {
    throw new Error(`no run of ${name}`)
  }

  while (going(readStatus(name)) || starting(readStatus(name))) {
    await pause(2000)
  }

  const ended = readStatus(name)

  console.log(describe(name, ended))
  process.exit(ended.state === 'done' && Number.isInteger(ended.code) ? ended.code : 2)
}

const main = async () => {
  const [command, ...argv] = process.argv.slice(2)

  if (command === 'start') {
    await start(argv)
  } else if (command === 'status') {
    status(argv)
  } else if (command === 'wait') {
    await wait(argv)
  } else if (command === 'supervise') {
    await supervise(argv[0], argv[1], argv.slice(2))
  } else {
    console.error('usage: bun scripts/run-check.js start [--label=<name>] <script> [arguments...] | status [<name>] | wait <name>')
    process.exit(2)
  }
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(2)
})
