// Runs the independent work of a check script (its mutants, mostly) several at a time. Each mutant already runs in a fresh copy of the modules, and the slow scripts spend most of their time on mutants one after another, so running them side by side cuts the wall time by about the number of cores without changing what any check or mutant proves.
// `CHECK_JOBS` sets how many run at once (scripts/check-all.js divides the machine between the scripts it runs); without it, one less than the cores, at least one.
const os = require('os')
const { spawn } = require('child_process')

const jobs = () => {
  const set = Number(process.env.CHECK_JOBS)

  return Number.isInteger(set) && set > 0 ? set : Math.max(1, (os.availableParallelism ? os.availableParallelism() : os.cpus().length) - 1)
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

// Runs `script` again with `args` in a process of its own (the runtime this one runs on) and resolves { code, stdout, stderr }. A child gets CHECK_JOBS=1, so its own pools do not multiply the processes.
const runChild = (script, args = [], { env = {}, maxBuffer = 1 << 28 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, CHECK_JOBS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''

  child.stdout.on('data', (chunk) => {
    stdout += chunk

    if (stdout.length > maxBuffer) {
      child.kill()
    }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code, stdout, stderr }))
})

// The JSON a child printed on its last line that starts with `prefix`, or an error naming how the child ended.
const lastJson = ({ code, stdout, stderr }, prefix = '') => {
  const line = stdout.split('\n').map((row) => row.trim()).filter((row) => row.startsWith(prefix) && row.length > prefix.length).pop()

  if (line === undefined) {
    throw new Error(`the child ended with status ${code} and printed no result: ${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}`)
  }

  return JSON.parse(line.slice(prefix.length))
}

module.exports = { jobs, inParallel, runChild, lastJson }
